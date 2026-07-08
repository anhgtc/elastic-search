/**
 * Tập hợp câu SQL đọc dữ liệu từ MySQL gốc (CHỈ ĐỌC) để đồng bộ sang ES.
 *
 * ─── TÊN CỘT (đã đối chiếu DDL thật: sql.sql / digilib_production) ───
 * Pivot dùng quy ước `<entity>_id`:
 *   tvs_document_has_author.author_id        (KHÔNG lọc status: default=2, không nhất quán)
 *   tvs_document_has_category.category_id
 *   tvs_document_has_genre.genre_id
 *   tvs_document_has_tag.tag_id
 *   tvs_document_has_collection.collection_id
 *   tvs_document_has_faculty.faculty_id
 *   tvs_document_has_major.major_id
 *   tvs_document_has_khoi_mon_hoc.khoi_mon_id + cột `type` (1=khối, 2=môn) NGAY TRÊN pivot
 *
 * baseSelect dùng `doc.*` nên mọi cột của tvs_document đều có sẵn
 * (name, other_name, short_desc, full_desc, subject, author_sub, serial_number,
 *  identifier, published_date, release_date, is_download, is_share, count_*, ...).
 *
 * Chiến lược: lấy batch document rồi nạp quan hệ theo lô id (IN (...)),
 * gộp trong Node -> nhẹ, không dùng 1 query khổng lồ nhiều GROUP_CONCAT.
 */

export function buildQueries(t: (name: string) => string) {
  const D = t('tvs_document');
  const PUB = t('tvs_publisher');
  const LANG = t('tvs_document_lang');

  const baseSelect = `
    SELECT doc.*, pub.name AS publisher_name, lang.name AS lang_name
    FROM ${D} doc
    LEFT JOIN ${PUB} pub  ON pub.id = doc.publisher_id
    LEFT JOIN ${LANG} lang ON lang.id = doc.document_lang_id
  `;

  return {
    /** Delta: keyset theo (updated_date, id) để bắt cả các bản trùng mốc thời gian. */
    baseDelta: `
      ${baseSelect}
      WHERE doc.updated_date > ?
         OR (doc.updated_date = ? AND doc.id > ?)
      ORDER BY doc.updated_date ASC, doc.id ASC
      LIMIT ?
    `,

    /** Full reindex: keyset theo id để quét toàn bộ. */
    baseAll: `
      ${baseSelect}
      WHERE doc.id > ?
      ORDER BY doc.id ASC
      LIMIT ?
    `,

    /** Đọc lại document theo danh sách id — dùng cho dependency reindex. */
    baseByIds: `
      ${baseSelect}
      WHERE doc.id IN (?)
    `,

    // Không lọc status ở pivot (default không nhất quán giữa các bảng).
    authors: `
      SELECT dha.document_id AS document_id, a.id AS id, a.name AS name
      FROM ${t('tvs_document_has_author')} dha
      JOIN ${t('tvs_author')} a ON a.id = dha.author_id
      WHERE dha.document_id IN (?)
    `,

    categories: `
      SELECT dhc.document_id AS document_id, c.id AS id, c.name AS name
      FROM ${t('tvs_document_has_category')} dhc
      JOIN ${t('tvs_category')} c ON c.id = dhc.category_id
      WHERE dhc.document_id IN (?)
    `,

    genres: `
      SELECT dhg.document_id AS document_id, g.id AS id, g.name AS name
      FROM ${t('tvs_document_has_genre')} dhg
      JOIN ${t('tvs_genre')} g ON g.id = dhg.genre_id
      WHERE dhg.document_id IN (?)
    `,

    tags: `
      SELECT dht.document_id AS document_id, tg.id AS id, tg.name AS name
      FROM ${t('tvs_document_has_tag')} dht
      JOIN ${t('tvs_tag')} tg ON tg.id = dht.tag_id
      WHERE dht.document_id IN (?)
    `,

    collections: `
      SELECT document_id AS document_id, collection_id AS id
      FROM ${t('tvs_document_has_collection')}
      WHERE document_id IN (?)
    `,

    // type (1=khối, 2=môn) nằm ngay trên pivot -> không cần join master.
    khoiMon: `
      SELECT document_id AS document_id, khoi_mon_id AS id, type AS type
      FROM ${t('tvs_document_has_khoi_mon_hoc')}
      WHERE document_id IN (?)
    `,

    faculties: `
      SELECT document_id AS document_id, faculty_id AS id
      FROM ${t('tvs_document_has_faculty')}
      WHERE document_id IN (?)
    `,

    majors: `
      SELECT document_id AS document_id, major_id AS id
      FROM ${t('tvs_document_has_major')}
      WHERE document_id IN (?)
    `,

    /** Bản in (offline): đếm paper_count + gom kho lưu trữ. status=3 coi như đã xoá. */
    offline: `
      SELECT document_id AS document_id,
             COUNT(*) AS paper_count,
             GROUP_CONCAT(DISTINCT document_storage_id) AS storage_ids
      FROM ${t('tvs_document_content_offline')}
      WHERE document_id IN (?) AND (status IS NULL OR status <> 3)
      GROUP BY document_id
    `,

    /** Metadata động (EAV): gom mọi giá trị mở rộng để search full-text. */
    metaExtend: `
      SELECT document_id AS document_id, meta_value_extend AS value
      FROM ${t('tvs_document_meta_extend')}
      WHERE document_id IN (?)
        AND meta_value_extend IS NOT NULL AND meta_value_extend <> ''
    `,

    /**
     * Phiếu chứa ấn phẩm — UNION 5 loại (borrow/import/inventory/liquidation/preorder).
     * Để "tìm theo tên phiếu -> ra ấn phẩm". Loại phiếu đã xoá (deleted=1) để tránh phình.
     * Kiểm kê (inventory) không có cột `name` -> dùng `code` làm tên.
     * 5 mệnh đề IN (?) -> truyền params [ids, ids, ids, ids, ids].
     */
    tickets: `
      SELECT p.document_id AS document_id, tk.id AS ticket_id,
             tk.code AS code, tk.name AS name, 'borrow' AS ttype
      FROM ${t('tvs_document_has_ticket_borrow_document')} p
      JOIN ${t('tvs_ticket_borrow_document')} tk ON tk.id = p.ticket_borrow_document_id
      WHERE p.document_id IN (?) AND (tk.deleted IS NULL OR tk.deleted <> 1)
      UNION ALL
      SELECT p.document_id, tk.id, tk.code, tk.name, 'import'
      FROM ${t('tvs_document_has_ticket_import_document')} p
      JOIN ${t('tvs_ticket_import_document')} tk ON tk.id = p.ticket_import_document_id
      WHERE p.document_id IN (?) AND (tk.deleted IS NULL OR tk.deleted <> 1)
      UNION ALL
      SELECT p.document_id, tk.id, tk.code, NULL, 'inventory'
      FROM ${t('tvs_document_has_ticket_inventory')} p
      JOIN ${t('tvs_ticket_inventory')} tk ON tk.id = p.ticket_inventory_id
      WHERE p.document_id IN (?)
      UNION ALL
      SELECT p.document_id, tk.id, tk.code, tk.name, 'liquidation'
      FROM ${t('tvs_document_has_ticket_liquidation_document')} p
      JOIN ${t('tvs_ticket_liquidation_document')} tk ON tk.id = p.ticket_liquidation_document_id
      WHERE p.document_id IN (?) AND (tk.deleted IS NULL OR tk.deleted <> 1)
      UNION ALL
      SELECT p.document_id, tk.id, tk.code, tk.name, 'preorder'
      FROM ${t('tvs_document_has_ticket_pre_order_document')} p
      JOIN ${t('tvs_ticket_pre_order_document')} tk ON tk.id = p.ticket_pre_order_document_id
      WHERE p.document_id IN (?)
    `,
  };
}

export type QuerySet = ReturnType<typeof buildQueries>;

/**
 * Các "nguồn phụ thuộc" phiếu — để phát hiện document bị ảnh hưởng khi PHIẾU đổi
 * (mà tvs_document.updated_date KHÔNG đổi). Mỗi nguồn:
 *  - `sql`   : lấy document_id có thay đổi > checkpoint (COALESCE(updated,created)).
 *  - `maxSql`: MAX(mốc thời gian) hiện tại — init checkpoint lần đầu để KHÔNG reindex toàn bộ.
 *
 * 2 chiều thay đổi:
 *  - PIVOT (has_ticket_*): thêm/bớt ấn phẩm khỏi phiếu, đổi status liên kết -> có document_id trực tiếp.
 *  - MASTER (ticket_*): đổi tên/mã/xoá mềm phiếu -> join pivot để lấy document_id.
 *
 * Hạn chế: nếu HARD-DELETE 1 dòng pivot thì không bắt được qua thời gian -> cần full-reindex định kỳ.
 */
export interface TicketDependency {
  name: string;
  sql: string;
  maxSql: string;
}

export function ticketDependencies(
  t: (name: string) => string,
): TicketDependency[] {
  const TYPES = [
    {
      key: 'borrow',
      pivot: 'tvs_document_has_ticket_borrow_document',
      fk: 'ticket_borrow_document_id',
      master: 'tvs_ticket_borrow_document',
    },
    {
      key: 'import',
      pivot: 'tvs_document_has_ticket_import_document',
      fk: 'ticket_import_document_id',
      master: 'tvs_ticket_import_document',
    },
    {
      key: 'inventory',
      pivot: 'tvs_document_has_ticket_inventory',
      fk: 'ticket_inventory_id',
      master: 'tvs_ticket_inventory',
    },
    {
      key: 'liquidation',
      pivot: 'tvs_document_has_ticket_liquidation_document',
      fk: 'ticket_liquidation_document_id',
      master: 'tvs_ticket_liquidation_document',
    },
    {
      key: 'preorder',
      pivot: 'tvs_document_has_ticket_pre_order_document',
      fk: 'ticket_pre_order_document_id',
      master: 'tvs_ticket_pre_order_document',
    },
  ];

  const deps: TicketDependency[] = [];
  for (const x of TYPES) {
    const P = t(x.pivot);
    const M = t(x.master);
    // Nguồn PIVOT: thêm/bớt/đổi status liên kết ấn phẩm-phiếu.
    deps.push({
      name: `pivot_${x.key}`,
      sql: `
        SELECT document_id AS document_id, COALESCE(updated_date, created_date) AS chg
        FROM ${P}
        WHERE COALESCE(updated_date, created_date) > ?
        ORDER BY COALESCE(updated_date, created_date) ASC
        LIMIT ?
      `,
      maxSql: `SELECT MAX(COALESCE(updated_date, created_date)) AS mx FROM ${P}`,
    });
    // Nguồn MASTER: đổi tên/mã/xoá mềm phiếu -> mọi ấn phẩm trong phiếu.
    deps.push({
      name: `master_${x.key}`,
      sql: `
        SELECT p.document_id AS document_id,
               COALESCE(m.updated_date, m.created_date) AS chg
        FROM ${M} m
        JOIN ${P} p ON p.${x.fk} = m.id
        WHERE COALESCE(m.updated_date, m.created_date) > ?
        ORDER BY COALESCE(m.updated_date, m.created_date) ASC
        LIMIT ?
      `,
      maxSql: `SELECT MAX(COALESCE(updated_date, created_date)) AS mx FROM ${M}`,
    });
  }
  return deps;
}
