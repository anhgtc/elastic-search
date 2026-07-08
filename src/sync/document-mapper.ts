/**
 * Chuyển 1 row `tvs_document` (đã kèm publisher_name, lang_name) + các quan hệ
 * đã gom theo document_id thành 1 ES document phẳng khớp mapping.
 */

export interface EntityRef {
  id: string;
  name: string;
}
export interface TicketRef {
  id: string;
  code: string;
  name: string;
  type: string;
}

export interface DocRelations {
  authors: EntityRef[];
  categories: EntityRef[];
  genres: EntityRef[];
  tags: EntityRef[];
  collectionIds: string[];
  khoiIds: string[];
  monIds: string[];
  facultyIds: string[];
  majorIds: string[];
  storageIds: string[];
  paperCount: number;
  metaValues: string[];
  tickets: TicketRef[];
}

export const EMPTY_RELATIONS: DocRelations = {
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

function str(v: any): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

function toInt(v: any): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function toFloat(v: any): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** Chuẩn hoá datetime: MySQL trả '0000-00-00 00:00:00' -> null (tránh lỗi date). */
function dateOrNull(v: any): string | null {
  const s = str(v);
  if (!s || s.startsWith('0000')) return null;
  return s;
}

/** Tách CSV "a,b,c" -> ['a','b','c'] (document_type_id có thể chứa nhiều loại). */
function csv(v: any): string[] {
  const s = str(v);
  if (!s) return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function mapToEsDoc(
  row: Record<string, any>,
  rel: DocRelations,
): Record<string, any> {
  const doc: Record<string, any> = {
    id: String(row.id),

    site_id: str(row.site_id),
    donvi_id: str(row.donvi_id),
    site_so_id: str(row.site_so_id), // dành cho kho dùng chung (nếu có)

    name: row.name ?? '',
    other_name: row.other_name ?? '',
    slug: str(row.slug),
    short_desc: row.short_desc ?? '',
    full_desc: row.full_desc ?? '',
    subject: row.subject ?? '',
    author_sub: row.author_sub ?? '',
    marc21_code: row.marc21_code ?? '',
    meta_text: rel.metaValues.join(' '),

    issn: str(row.issn),
    isbn: str(row.isbn),
    serial_number: str(row.serial_number),
    identifier: str(row.identifier),
    so_tapchi: str(row.so_tapchi),

    publisher_id: str(row.publisher_id),
    publisher_name: row.publisher_name ?? '',

    authors: rel.authors,
    categories: rel.categories,
    genres: rel.genres,
    tags: rel.tags,
    collection_ids: rel.collectionIds,

    document_lang_id: str(row.document_lang_id),
    lang_name: str(row.lang_name),

    khoi_ids: rel.khoiIds,
    mon_ids: rel.monIds,
    faculty_ids: rel.facultyIds,
    major_ids: rel.majorIds,

    document_storage_ids: rel.storageIds,
    // document_type_id = loại tài liệu/file (PDF/EPUB/SCORM/Video...),
    // có thể là CSV nhiều loại -> tách mảng cho filter ft_id.
    file_type_ids: csv(row.document_type_id),
    document_type_id: str(row.document_type_id),

    // Phiếu chứa ấn phẩm (để tìm ấn phẩm theo tên/mã/loại phiếu).
    tickets: rel.tickets,

    is_tapchi: toInt(row.is_tapchi),
    loai_hinh_id: str(row.is_tapchi), // loại hình = tạp chí/ấn phẩm/nội sinh
    type_extra: toInt(row.type_extra),
    status: toInt(row.status),
    status_share: toInt(row.status_share),
    is_download: toInt(row.is_download),
    is_share: toInt(row.is_share),

    cover_id: str(row.cover_id),
    color: str(row.color),
    partner_id: str(row.partner_id),
    partner_document_id: str(row.partner_document_id),
    tapchi_id: str(row.tapchi_id),
    symbol_id: str(row.symbol_id),

    release_date: str(row.release_date), // varchar tự do -> keyword
    published_date: dateOrNull(row.published_date),
    created_date: dateOrNull(row.created_date),
    updated_date: dateOrNull(row.updated_date),

    paper_count: rel.paperCount,
    count_view: toInt(row.count_view),
    count_readed: toInt(row.count_readed),
    count_download: toInt(row.count_download),
    count_like: toInt(row.count_like),
    count_comment: toInt(row.count_comment),
    avg_score_rate: toFloat(row.avg_score_rate),
  };

  // rank_feature: giá trị PHẢI > 0 (nếu = 0 thì bỏ field, doc không được boost).
  const view = toInt(row.count_view);
  const rate = toFloat(row.avg_score_rate);
  const dl = toInt(row.count_download);
  if (view > 0) doc.popularity = view;
  if (rate > 0) doc.rating = rate;
  if (dl > 0) doc.downloads = dl;

  return doc;
}
