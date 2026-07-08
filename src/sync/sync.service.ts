import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { MysqlService } from '../common/mysql/mysql.service';
import { ElasticService } from '../common/elastic/elastic.service';
import { RedisService } from '../common/redis/redis.service';
import {
  buildQueries,
  QuerySet,
  ticketDependencies,
  TicketDependency,
} from './queries';
import { DocRelations, mapToEsDoc } from './document-mapper';

interface Checkpoint {
  date: string;
  id: string;
}

const CHECKPOINT_KEY = 'sync:checkpoint';
const DEFAULT_CP: Checkpoint = { date: '1970-01-01 00:00:00', id: '' };

function newRelations(): DocRelations {
  return {
    authors: [],
    categories: [],
    genres: [],
    tags: [],
    collectionIds: [],
    khoiIds: [],
    monIds: [],
    facultyIds: [],
    majorIds: [],
    storageIds: [],
    paperCount: 0,
    metaValues: [],
    tickets: [],
  };
}

/** So sánh 2 checkpoint (date rồi id). Trả về true nếu a > b. */
function cpGreater(a: Checkpoint, b: Checkpoint): boolean {
  if (a.date !== b.date) return a.date > b.date;
  return a.id > b.id;
}

@Injectable()
export class SyncService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(SyncService.name);
  private q!: QuerySet;
  private running = false;
  private batchSize!: number;
  private deps: TicketDependency[] = [];
  private depsEnabled = true;

  constructor(
    private readonly config: ConfigService,
    private readonly mysql: MysqlService,
    private readonly elastic: ElasticService,
    private readonly redis: RedisService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    this.q = buildQueries((n) => this.mysql.table(n));
    const sync = this.config.get('sync') as any;
    this.batchSize = sync.batchSize;
    this.depsEnabled = sync.depsEnabled;
    this.deps = ticketDependencies((n) => this.mysql.table(n));
  }

  async onApplicationBootstrap(): Promise<void> {
    const sync = this.config.get('sync') as any;
    const mode = this.config.get('appMode');
    // Chế độ reindex do main.ts điều khiển trực tiếp; ở đây chỉ tự động cho worker.
    if (mode !== 'worker') return;

    await this.elastic.waitReady();

    if (sync.bootstrapReindex && !(await this.elastic.aliasExists())) {
      this.logger.log('Alias chưa tồn tại -> chạy full reindex khởi tạo.');
      await this.fullReindex();
    } else {
      await this.elastic.ensureWriteIndex();
    }

    if (sync.enabled) {
      await this.runDelta().catch((e) =>
        this.logger.error(`Delta sync khởi tạo lỗi: ${e.message}`),
      );
      this.registerCron(sync.cron);
    } else {
      this.logger.warn('SYNC_ENABLED=false -> bỏ qua lịch delta sync.');
    }
  }

  private registerCron(cronExpr: string): void {
    const job = new CronJob(cronExpr, () => {
      this.runDelta().catch((e) =>
        this.logger.error(`Delta sync lỗi: ${e.message}`),
      );
    });
    this.scheduler.addCronJob('delta-sync', job as any);
    job.start();
    this.logger.log(`Đã lên lịch delta sync: "${cronExpr}"`);
  }

  // ────────────────────────────── DELTA ──────────────────────────────

  async runDelta(): Promise<void> {
    if (this.running) {
      this.logger.debug('Delta sync trước chưa xong -> bỏ qua nhịp này.');
      return;
    }
    this.running = true;
    const started = new Date();
    try {
      const index = await this.elastic.ensureWriteIndex();
      let cursor = await this.readCheckpoint();
      let total = 0;

      while (true) {
        const rows = await this.mysql.query(this.q.baseDelta, [
          cursor.date,
          cursor.date,
          cursor.id,
          this.batchSize,
        ]);
        if (rows.length === 0) break;

        const docs = await this.buildDocs(rows);
        const res = await this.elastic.bulk(index, docs);
        total += res.indexed + res.deleted;

        const last = rows[rows.length - 1];
        cursor = { date: String(last.updated_date), id: String(last.id) };
        await this.writeCheckpoint(cursor);

        if (rows.length < this.batchSize) break;
      }

      // Theo dõi thay đổi PHIẾU -> reindex các ấn phẩm liên quan (delta thường bỏ sót).
      let depTotal = 0;
      if (this.depsEnabled) {
        depTotal = await this.runDependencySync(index);
      }

      if (total > 0 || depTotal > 0) {
        await this.elastic.refresh(index);
        this.logger.log(
          `Delta sync: ${total} tài liệu, ${depTotal} theo phiếu ` +
            `(${Date.now() - started.getTime()}ms).`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  // ───────────────────── DEPENDENCY SYNC (phiếu) ─────────────────────

  /**
   * Quét các nguồn phụ thuộc phiếu, gom document_id bị ảnh hưởng rồi reindex chúng.
   * Trả về số document đã reindex.
   */
  private async runDependencySync(index: string): Promise<number> {
    const affected = new Set<string>();

    for (const dep of this.deps) {
      const key = `sync:dep:${dep.name}`;
      let cp = await this.redis.get(key);

      // Lần đầu: khởi tạo checkpoint = MAX hiện tại (KHÔNG reindex toàn bộ), rồi bỏ qua.
      if (!cp) {
        const rows = await this.mysql.query(dep.maxSql, []);
        cp = rows[0]?.mx ? String(rows[0].mx) : DEFAULT_CP.date;
        await this.redis.set(key, cp);
        continue;
      }

      // Keyset theo mốc thời gian thay đổi.
      while (true) {
        const rows = await this.mysql.query(dep.sql, [cp, this.batchSize]);
        if (rows.length === 0) break;
        for (const r of rows) {
          if (r.document_id) affected.add(String(r.document_id));
        }
        cp = String(rows[rows.length - 1].chg);
        await this.redis.set(key, cp);
        if (rows.length < this.batchSize) break;
      }
    }

    if (affected.size === 0) return 0;
    return this.reindexByIds(index, [...affected]);
  }

  /** Đọc lại document theo danh sách id và index lại (idempotent). */
  private async reindexByIds(index: string, ids: string[]): Promise<number> {
    let total = 0;
    for (let i = 0; i < ids.length; i += this.batchSize) {
      const chunk = ids.slice(i, i + this.batchSize);
      const rows = await this.mysql.query(this.q.baseByIds, [chunk]);
      if (rows.length === 0) continue;
      const docs = await this.buildDocs(rows);
      const res = await this.elastic.bulk(index, docs);
      total += res.indexed;
    }
    return total;
  }

  // ─────────────────────────── FULL REINDEX ───────────────────────────

  async fullReindex(): Promise<void> {
    this.logger.log('Bắt đầu FULL REINDEX...');
    const index = await this.elastic.createVersionedIndex();
    let lastId = '';
    let total = 0;
    let maxCp: Checkpoint = { ...DEFAULT_CP };

    while (true) {
      const rows = await this.mysql.query(this.q.baseAll, [
        lastId,
        this.batchSize,
      ]);
      if (rows.length === 0) break;

      const docs = await this.buildDocs(rows);
      const res = await this.elastic.bulk(index, docs);
      total += res.indexed;

      for (const r of rows) {
        const cp: Checkpoint = {
          date: String(r.updated_date ?? DEFAULT_CP.date),
          id: String(r.id),
        };
        if (cpGreater(cp, maxCp)) maxCp = cp;
      }
      lastId = String(rows[rows.length - 1].id);

      if (rows.length < this.batchSize) break;
      this.logger.log(`  ... đã index ${total} tài liệu`);
    }

    await this.elastic.refresh(index);
    await this.elastic.switchAlias(index);
    await this.writeCheckpoint(maxCp);
    this.logger.log(`FULL REINDEX xong: ${total} tài liệu -> ${index}.`);
  }

  // ─────────────────────────── DENORMALIZE ───────────────────────────

  private async buildDocs(
    rows: Record<string, any>[],
  ): Promise<
    { id: string; doc: Record<string, any> | null; routing?: string }[]
  > {
    const ids = rows.map((r) => String(r.id));

    const [aut, cat, gen, tg, col, km, fac, maj, off, meta, tks] =
      await Promise.all([
        this.mysql.query(this.q.authors, [ids]),
        this.mysql.query(this.q.categories, [ids]),
        this.mysql.query(this.q.genres, [ids]),
        this.mysql.query(this.q.tags, [ids]),
        this.mysql.query(this.q.collections, [ids]),
        this.mysql.query(this.q.khoiMon, [ids]),
        this.mysql.query(this.q.faculties, [ids]),
        this.mysql.query(this.q.majors, [ids]),
        this.mysql.query(this.q.offline, [ids]),
        this.mysql.query(this.q.metaExtend, [ids]),
        // tickets: query UNION có 5 mệnh đề IN (?) -> 5 lần ids
        this.mysql.query(this.q.tickets, [ids, ids, ids, ids, ids]),
      ]);

    const map = new Map<string, DocRelations>();
    const rel = (docId: any): DocRelations => {
      const k = String(docId);
      let r = map.get(k);
      if (!r) {
        r = newRelations();
        map.set(k, r);
      }
      return r;
    };

    for (const r of aut) {
      rel(r.document_id).authors.push({
        id: String(r.id),
        name: r.name ? String(r.name) : '',
      });
    }
    for (const r of cat) {
      rel(r.document_id).categories.push({
        id: String(r.id),
        name: r.name ? String(r.name) : '',
      });
    }
    for (const r of gen) {
      rel(r.document_id).genres.push({
        id: String(r.id),
        name: r.name ? String(r.name) : '',
      });
    }
    for (const r of tg) {
      rel(r.document_id).tags.push({
        id: String(r.id),
        name: r.name ? String(r.name) : '',
      });
    }
    for (const r of col) {
      rel(r.document_id).collectionIds.push(String(r.id));
    }
    for (const r of km) {
      const x = rel(r.document_id);
      if (Number(r.type) === 2) x.monIds.push(String(r.id));
      else x.khoiIds.push(String(r.id));
    }
    for (const r of fac) {
      rel(r.document_id).facultyIds.push(String(r.id));
    }
    for (const r of maj) {
      rel(r.document_id).majorIds.push(String(r.id));
    }
    for (const r of off) {
      const x = rel(r.document_id);
      x.paperCount = parseInt(r.paper_count, 10) || 0;
      x.storageIds = r.storage_ids
        ? String(r.storage_ids)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    }
    for (const r of meta) {
      if (r.value) rel(r.document_id).metaValues.push(String(r.value));
    }
    for (const r of tks) {
      const x = rel(r.document_id);
      const tid = String(r.ticket_id);
      if (x.tickets.some((t) => t.id === tid)) continue; // dedup theo id
      x.tickets.push({
        id: tid,
        code: r.code ? String(r.code) : '',
        // inventory không có name -> dùng code làm "tên phiếu"
        name: r.name ? String(r.name) : r.code ? String(r.code) : '',
        type: r.ttype ? String(r.ttype) : '',
      });
    }

    return rows.map((row) => ({
      id: String(row.id),
      routing: row.site_id != null ? String(row.site_id) : undefined,
      doc: mapToEsDoc(row, map.get(String(row.id)) ?? newRelations()),
    }));
  }

  // ─────────────────────────── CHECKPOINT ───────────────────────────

  private async readCheckpoint(): Promise<Checkpoint> {
    const raw = await this.redis.get(CHECKPOINT_KEY);
    if (!raw) return { ...DEFAULT_CP };
    try {
      const cp = JSON.parse(raw);
      return { date: cp.date || DEFAULT_CP.date, id: cp.id || '' };
    } catch {
      return { ...DEFAULT_CP };
    }
  }

  private async writeCheckpoint(cp: Checkpoint): Promise<void> {
    await this.redis.set(CHECKPOINT_KEY, JSON.stringify(cp));
  }
}
