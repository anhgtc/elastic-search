import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ElasticService } from '../common/elastic/elastic.service';

const RANK_FEATURES = ['popularity', 'rating', 'downloads'];

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(private readonly elastic: ElasticService) {}

  /** Làm sạch payload: rank_feature phải > 0, nếu không thì bỏ (ES sẽ báo lỗi nếu = 0). */
  private sanitize(doc: Record<string, any>): Record<string, any> {
    const out = { ...doc };
    for (const f of RANK_FEATURES) {
      if (out[f] === undefined || out[f] === null) continue;
      const n = Number(out[f]);
      if (!(n > 0)) delete out[f];
      else out[f] = n;
    }
    return out;
  }

  /** Upsert nhiều document (payload đầy đủ). routing lấy từ site_id. */
  async upsert(documents: Record<string, any>[], refresh = false) {
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new BadRequestException('documents rỗng');
    }
    const items = documents.map((d) => {
      if (d.id === undefined || d.id === null || d.id === '') {
        throw new BadRequestException('mỗi document phải có "id"');
      }
      return {
        id: String(d.id),
        routing: d.site_id != null ? String(d.site_id) : undefined,
        doc: this.sanitize(d),
      };
    });

    const index = await this.elastic.ensureWriteIndex();
    const res = await this.elastic.bulk(index, items);
    if (refresh) await this.elastic.refresh(index);
    this.logger.log(
      `Ingest upsert: ${res.indexed} indexed, ${res.errors} lỗi -> ${index}`,
    );
    return { ...res, index };
  }

  /**
   * Cập nhật 1 thực thể dùng chung đổi tên -> sửa MỌI ấn phẩm chứa nó.
   * - Loại mảng-đối-tượng (author/category/genre/tag/ticket): sửa phần tử có id khớp.
   * - Loại đơn (publisher/lang): gán thẳng field tên.
   */
  async updateEntity(
    type: string,
    id: string,
    name: string,
    refresh = false,
  ) {
    // field = tên field trong _source; match = field để lọc doc chứa thực thể.
    const OBJ: Record<string, { field: string; match: string }> = {
      author: { field: 'authors', match: 'authors.id' },
      category: { field: 'categories', match: 'categories.id' },
      genre: { field: 'genres', match: 'genres.id' },
      tag: { field: 'tags', match: 'tags.id' },
      ticket: { field: 'tickets', match: 'tickets.id' },
    };
    const SINGLE: Record<string, { field: string; match: string }> = {
      publisher: { field: 'publisher_name', match: 'publisher_id' },
      lang: { field: 'lang_name', match: 'document_lang_id' },
    };

    let matchField: string;
    let script: any;
    if (OBJ[type]) {
      matchField = OBJ[type].match;
      script = {
        source:
          'def arr = ctx._source[params.field];' +
          'if (arr != null) { for (int i = 0; i < arr.size(); i++) {' +
          ' if (arr[i].id == params.id) { arr[i].name = params.name } } }',
        params: { field: OBJ[type].field, id: String(id), name },
      };
    } else if (SINGLE[type]) {
      matchField = SINGLE[type].match;
      script = {
        source: 'ctx._source[params.field] = params.name',
        params: { field: SINGLE[type].field, name },
      };
    } else {
      throw new BadRequestException(`type không hợp lệ: ${type}`);
    }

    const res: any = await this.elastic.client.updateByQuery({
      index: this.elastic.alias,
      conflicts: 'proceed',
      refresh: !!refresh,
      query: { term: { [matchField]: String(id) } },
      script,
    });
    this.logger.log(
      `update-entity ${type}=${id} -> ${res.updated}/${res.total} ấn phẩm cập nhật`,
    );
    return {
      type,
      id,
      matched: res.total,
      updated: res.updated,
      conflicts: res.version_conflicts,
    };
  }

  /** Xoá document theo id (+ site_id để định tuyến đúng shard). */
  async remove(items: { id: string; site_id?: string }[], refresh = false) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('documents rỗng');
    }
    const ops = items.map((it) => ({
      id: String(it.id),
      routing: it.site_id != null ? String(it.site_id) : undefined,
      doc: null,
    }));

    const index = await this.elastic.ensureWriteIndex();
    const res = await this.elastic.bulk(index, ops);
    if (refresh) await this.elastic.refresh(index);
    this.logger.log(`Ingest delete: ${res.deleted} xoá, ${res.errors} lỗi`);
    return { ...res, index };
  }
}
