import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@elastic/elasticsearch';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Bọc Elasticsearch client + quản lý vòng đời index theo mô hình alias + versioned index
 * (zero-downtime reindex).
 *
 *   alias  = ELASTIC_INDEX_ALIAS            (vd: tvs_documents)  <- API luôn query alias này
 *   index  = <alias>_<timestamp>            (vd: tvs_documents_1720000000000)
 */
@Injectable()
export class ElasticService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ElasticService.name);
  private _client!: Client;
  private _alias!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const cfg = this.config.get('elastic') as any;
    this._alias = cfg.indexAlias;
    const auth =
      cfg.username && cfg.password
        ? { username: cfg.username, password: cfg.password }
        : undefined;
    this._client = new Client({
      node: cfg.node,
      auth,
      tls: cfg.node.startsWith('https')
        ? { rejectUnauthorized: cfg.rejectUnauthorized }
        : undefined,
      requestTimeout: 30000,
      maxRetries: 3,
    });
    this.logger.log(`Elasticsearch client -> ${cfg.node} (alias=${this._alias})`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this._client) await this._client.close();
  }

  get client(): Client {
    return this._client;
  }

  get alias(): string {
    return this._alias;
  }

  /** Ping ES, thử lại tối đa `retries` lần (chờ ES sẵn sàng khi khởi động). */
  async waitReady(retries = 30, delayMs = 2000): Promise<void> {
    for (let i = 1; i <= retries; i++) {
      try {
        await this._client.ping();
        this.logger.log('Elasticsearch đã sẵn sàng.');
        return;
      } catch (e: any) {
        this.logger.warn(
          `Chờ Elasticsearch... (${i}/${retries}) ${e?.message ?? ''}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error('Không kết nối được Elasticsearch sau nhiều lần thử.');
  }

  /** Đọc file mapping từ đĩa (elasticsearch/documents.mapping.json). */
  loadMapping(): Record<string, any> {
    const p = path.resolve(process.cwd(), 'elasticsearch/documents.mapping.json');
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }

  async aliasExists(): Promise<boolean> {
    return this._client.indices.existsAlias({ name: this._alias });
  }

  /** Trả về tên index vật lý mà alias đang trỏ tới (nếu có). */
  async getIndicesBehindAlias(): Promise<string[]> {
    try {
      const res = await this._client.indices.getAlias({ name: this._alias });
      return Object.keys(res);
    } catch {
      return [];
    }
  }

  /** Tạo một index vật lý mới (versioned) với mapping, CHƯA gắn alias. */
  async createVersionedIndex(): Promise<string> {
    const indexName = `${this._alias}_${Date.now()}`;
    const body = this.loadMapping();
    await this._client.indices.create({ index: indexName, ...body });
    this.logger.log(`Đã tạo index mới: ${indexName}`);
    return indexName;
  }

  /**
   * Đảm bảo alias tồn tại và trỏ vào 1 index ghi. Dùng cho delta sync:
   * nếu chưa có gì -> tạo index mới + gắn alias, trả về tên index đó.
   */
  async ensureWriteIndex(): Promise<string> {
    if (await this.aliasExists()) {
      const indices = await this.getIndicesBehindAlias();
      return indices[0];
    }
    const indexName = await this.createVersionedIndex();
    await this._client.indices.putAlias({
      index: indexName,
      name: this._alias,
    });
    this.logger.log(`Gắn alias ${this._alias} -> ${indexName}`);
    return indexName;
  }

  /** Chuyển alias sang index mới (atomic) và xoá các index cũ. */
  async switchAlias(newIndex: string): Promise<void> {
    const oldIndices = await this.getIndicesBehindAlias();
    const actions: any[] = [{ add: { index: newIndex, alias: this._alias } }];
    for (const old of oldIndices) {
      if (old !== newIndex) {
        actions.push({ remove: { index: old, alias: this._alias } });
      }
    }
    await this._client.indices.updateAliases({ actions });
    this.logger.log(`Alias ${this._alias} -> ${newIndex} (atomic).`);

    for (const old of oldIndices) {
      if (old !== newIndex) {
        await this._client.indices.delete({ index: old }).catch(() => undefined);
        this.logger.log(`Đã xoá index cũ: ${old}`);
      }
    }
  }

  /**
   * Bulk index/xoá tài liệu.
   * @param index tên index vật lý đích
   * @param docs  mảng { id, doc, routing } — doc=null nghĩa là xoá.
   *   routing (= site_id) gom doc cùng tenant vào 1 shard; delete phải cùng routing.
   */
  async bulk(
    index: string,
    docs: { id: string; doc: Record<string, any> | null; routing?: string }[],
  ): Promise<{ indexed: number; deleted: number; errors: number }> {
    if (docs.length === 0) return { indexed: 0, deleted: 0, errors: 0 };

    const operations: any[] = [];
    let indexed = 0;
    let deleted = 0;
    for (const { id, doc, routing } of docs) {
      const meta: any = { _index: index, _id: id };
      if (routing) meta.routing = routing;
      if (doc === null) {
        operations.push({ delete: meta });
        deleted++;
      } else {
        operations.push({ index: meta });
        operations.push(doc);
        indexed++;
      }
    }

    const res = await this._client.bulk({ operations, refresh: false });
    let errors = 0;
    if (res.errors) {
      for (const item of res.items) {
        const op = item.index || item.delete || item.create || item.update;
        if (op?.error) {
          errors++;
          this.logger.error(
            `Bulk lỗi _id=${op._id}: ${JSON.stringify(op.error)}`,
          );
        }
      }
    }
    return { indexed, deleted, errors };
  }

  async refresh(index?: string): Promise<void> {
    await this._client.indices.refresh({ index: index ?? this._alias });
  }
}
