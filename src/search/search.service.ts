import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ElasticService } from '../common/elastic/elastic.service';
import { RedisService } from '../common/redis/redis.service';
import { SearchDto, SuggestDto } from './dto/search.dto';

function toArray(v: any): string[] {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  return [String(v)];
}

function toInt(v: any, fallback: number): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function isTrue(v: any): boolean {
  return v === true || v === '1' || v === 'true';
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly elastic: ElasticService,
    private readonly redis: RedisService,
  ) {}

  // ─────────────────────────── SEARCH ───────────────────────────

  async search(dto: SearchDto) {
    const page = Math.max(1, toInt(dto.page, 1));
    const limit = Math.min(100, Math.max(1, toInt(dto.limit, 18)));
    const from = (page - 1) * limit;

    const keyword = (dto.t ?? '').trim();
    const { filter, useGlobal } = this.buildFilters(dto);

    // Điều kiện match theo từ khoá (bất kỳ nhánh nào khớp là đủ).
    const must: any[] = [];
    if (keyword) {
      must.push({
        bool: {
          should: [
            {
              multi_match: {
                query: keyword,
                type: 'best_fields',
                fuzziness: 'AUTO',
                prefix_length: 2,
                max_expansions: 50,
                fields: [
                  'name^5',
                  'other_name^4',
                  'authors.name^3',
                  'author_sub^2',
                  'publisher_name^2',
                  'categories.name^2',
                  'subject^2',
                  'genres.name^1.5',
                  'tags.name^1.5',
                  'short_desc',
                  'full_desc',
                  'meta_text',
                ],
              },
            },
            { match_phrase: { name: { query: keyword, boost: 4 } } },
            { term: { issn: keyword } },
            { term: { isbn: keyword } },
            { term: { id: keyword } },
          ],
          minimum_should_match: 1,
        },
      });
    }

    // Tìm ấn phẩm theo TÊN phiếu (operator AND -> khớp đủ token, chính xác hơn).
    const ticketName = (dto.ticket_name ?? '').trim();
    if (ticketName) {
      must.push({
        match: { 'tickets.name': { query: ticketName, operator: 'and' } },
      });
    }

    const { sort, useScore } = this.buildSort(dto.s, !!keyword);

    const boolQuery: any = { bool: { filter } };
    if (must.length) boolQuery.bool.must = must;

    // Boost độ phổ biến bằng rank_feature (rẻ hơn function_score ở quy mô triệu doc).
    // Chỉ thêm khi xếp theo relevance (có từ khoá).
    if (useScore) {
      boolQuery.bool.should = [
        { rank_feature: { field: 'popularity', log: { scaling_factor: 4 } } },
        { rank_feature: { field: 'rating', saturation: { pivot: 4 } } },
        { rank_feature: { field: 'downloads', log: { scaling_factor: 2 } } },
      ];
    }

    const res = await this.elastic.client.search({
      index: this.elastic.alias,
      // routing theo site_id: tìm 1 tenant chỉ chạm 1 shard (bỏ qua khi tìm kho chung)
      ...(useGlobal || !dto.site_id ? {} : { routing: String(dto.site_id) }),
      from,
      size: limit,
      track_total_hits: true,
      query: boolQuery,
      sort,
    });

    const totalRaw = res.hits.total as any;
    const total = typeof totalRaw === 'number' ? totalRaw : (totalRaw?.value ?? 0);
    const data = res.hits.hits.map((h: any) => ({
      ...h._source,
      _score: h._score,
    }));

    return {
      data,
      paging: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
      meta: { keyword, global: useGlobal },
    };
  }

  // ─────────────────────────── FACETS ───────────────────────────

  async facets(dto: SearchDto) {
    const keyword = (dto.t ?? '').trim();
    const { filter, useGlobal } = this.buildFilters(dto);
    const must: any[] = [];
    if (keyword) {
      must.push({
        multi_match: {
          query: keyword,
          fields: ['name^3', 'authors.name', 'short_desc', 'full_desc'],
          fuzziness: 'AUTO',
        },
      });
    }
    const boolQuery: any = { bool: { filter } };
    if (must.length) boolQuery.bool.must = must;

    const res = await this.elastic.client.search({
      index: this.elastic.alias,
      ...(useGlobal || !dto.site_id ? {} : { routing: String(dto.site_id) }),
      size: 0,
      query: boolQuery,
      // Chỉ facet field cardinality THẤP (đã bật eager_global_ordinals).
      // KHÔNG facet author_ids/publisher_id (cardinality cao -> tốn RAM);
      // các trường này dùng làm filter + search, không đếm buckets.
      aggs: {
        category: { terms: { field: 'categories.id', size: 50 } },
        genre: { terms: { field: 'genres.id', size: 50 } },
        language: { terms: { field: 'document_lang_id', size: 20 } },
        file_type: { terms: { field: 'file_type_ids', size: 30 } },
        ticket_type: { terms: { field: 'tickets.type', size: 10 } },
        type_extra: { terms: { field: 'type_extra', size: 5 } },
        is_tapchi: { terms: { field: 'is_tapchi', size: 5 } },
      },
    });

    const aggs: any = res.aggregations || {};
    const pick = (a: any) =>
      (a?.buckets || []).map((b: any) => ({ key: b.key, count: b.doc_count }));

    return {
      category: pick(aggs.category),
      genre: pick(aggs.genre),
      language: pick(aggs.language),
      file_type: pick(aggs.file_type),
      ticket_type: pick(aggs.ticket_type),
      type_extra: pick(aggs.type_extra),
      is_tapchi: pick(aggs.is_tapchi),
    };
  }

  // ─────────────────────────── SUGGEST ───────────────────────────

  async suggest(dto: SuggestDto) {
    const keyword = (dto.t ?? '').trim();
    const limit = Math.min(20, Math.max(1, toInt(dto.limit, 10)));
    if (!dto.site_id) throw new BadRequestException('site_id là bắt buộc');
    if (keyword.length < 2) return { data: [] };

    const cacheKey = `suggest:${dto.site_id}:${keyword.toLowerCase()}:${limit}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return { data: JSON.parse(cached), cached: true };

    const filter: any[] = [
      { term: { site_id: String(dto.site_id) } },
      { term: { status: 1 } },
    ];
    if (dto.donvi_id) filter.push({ term: { donvi_id: String(dto.donvi_id) } });

    const res = await this.elastic.client.search({
      index: this.elastic.alias,
      routing: String(dto.site_id), // suggest luôn scope theo site -> 1 shard
      size: limit,
      _source: ['id', 'name', 'slug', 'cover_id'],
      query: {
        bool: {
          filter,
          must: [
            {
              // search_as_you_type: gõ tới đâu gợi ý tới đó, không quét prefix runtime
              multi_match: {
                query: keyword,
                type: 'bool_prefix',
                fields: [
                  'name.auto',
                  'name.auto._2gram',
                  'name.auto._3gram',
                ],
              },
            },
          ],
        },
      },
    });

    const data = res.hits.hits.map((h: any) => h._source);
    await this.redis.set(cacheKey, JSON.stringify(data), 300);
    return { data };
  }

  // ─────────────────────────── HELPERS ───────────────────────────

  private buildFilters(dto: SearchDto): { filter: any[]; useGlobal: boolean } {
    const filter: any[] = [];
    const useGlobal = isTrue(dto.global);

    if (useGlobal) {
      // Kho dùng chung theo site Sở
      if (!dto.site_so_id) {
        throw new BadRequestException('global=true yêu cầu site_so_id');
      }
      filter.push({ term: { site_so_id: String(dto.site_so_id) } });
      filter.push({ term: { status_share: 1 } });
    } else {
      if (!dto.site_id) throw new BadRequestException('site_id là bắt buộc');
      filter.push({ term: { site_id: String(dto.site_id) } });
      if (dto.donvi_id) {
        filter.push({ term: { donvi_id: String(dto.donvi_id) } });
      }
    }

    // Trạng thái document (mặc định 1 = công khai)
    filter.push({ term: { status: toInt(dto.status_id, 1) } });

    const addTerms = (field: string, value: any) => {
      const arr = toArray(value);
      if (arr.length) filter.push({ terms: { [field]: arr } });
    };

    addTerms('categories.id', dto.cate_id);
    addTerms('genres.id', dto.ge_id);
    addTerms('authors.id', dto.au_id);
    addTerms('publisher_id', dto.pub_id);
    addTerms('collection_ids', dto.collect_id);
    addTerms('document_lang_id', dto.lang_id);
    addTerms('tags.id', dto.tag_id);
    addTerms('khoi_ids', dto.khoi_id);
    addTerms('mon_ids', dto.mon_id);
    addTerms('faculty_ids', dto.faculty_id);
    addTerms('major_ids', dto.major_id);
    addTerms('document_storage_ids', dto.document_storage_id);
    addTerms('file_type_ids', dto.ft_id);
    addTerms('tickets.id', dto.ticket_id);
    addTerms('tickets.code', dto.ticket_code);
    addTerms('tickets.type', dto.ticket_type);

    if (dto.loai_hinh_id !== undefined && dto.loai_hinh_id !== '') {
      filter.push({ term: { is_tapchi: toInt(dto.loai_hinh_id, 2) } });
    }
    if (dto.type_extra !== undefined && dto.type_extra !== '') {
      filter.push({ term: { type_extra: toInt(dto.type_extra, 0) } });
    }

    return { filter, useGlobal };
  }

  private buildSort(
    s: string | undefined,
    hasKeyword: boolean,
  ): { sort: any[]; useScore: boolean } {
    switch (s) {
      case 'name_asc':
        return { sort: [{ 'name.sort': 'asc' }], useScore: false };
      case 'paper_count':
        return {
          sort: [{ paper_count: 'desc' }, { created_date: 'desc' }],
          useScore: false,
        };
      case 'newest':
        return { sort: [{ created_date: 'desc' }], useScore: false };
      default:
        if (hasKeyword) {
          return { sort: ['_score', { created_date: 'desc' }], useScore: true };
        }
        return {
          sort: [{ created_date: 'desc' }, { updated_date: 'desc' }],
          useScore: false,
        };
    }
  }
}
