# Thiết kế cấu trúc dữ liệu Elasticsearch (Index Design)

> Mục tiêu: tối ưu **truy vấn** cho quy mô **hàng triệu ấn phẩm × hàng nghìn tenant**
> với metadata phong phú (tác giả, NXB, thể loại, khối/môn...).

---

## 1. Nguyên lý nền: document phẳng, không JOIN

MySQL chuẩn hóa: `tvs_document` + ~10 bảng `tvs_document_has_*` → JOIN lúc query = chậm.

Elasticsearch làm ngược lại — **denormalize**: gom mọi thứ cần cho tìm kiếm vào **1
document phẳng**, JOIN xảy ra **1 lần lúc index** (trong sync-worker), query chỉ đọc 1 chỗ.

- ❌ KHÔNG dùng `nested` / parent-child (join field): ở quy mô triệu doc chúng phá hiệu năng.
- ✅ Mỗi ấn phẩm = 1 document chứa sẵn `author_names`, `category_ids`, `genre_names`...

Đánh đổi: dữ liệu lặp + phải reindex khi metadata dùng chung đổi tên. Chấp nhận được vì
tìm kiếm là read-heavy, và việc cập nhật do sync-worker lo.

## 2. Chiến lược multi-tenant: shared index + custom routing

**Chọn: 1 index chung cho tất cả tenant + `routing = site_id`.**

| Phương án | Với hàng nghìn tenant |
|---|---|
| Index-per-tenant | ❌ Nổ hàng nghìn index × shard → cluster sụp (mỗi shard tốn ~vài MB heap) |
| **Shared + routing** | ✅ Mỗi tenant gom vào **1 shard**; tìm 1 trường chỉ chạm 1 shard thay vì cả 8 |

Cách hoạt động:
- **Index:** mỗi doc ghi kèm `routing = site_id` → mọi doc cùng site nằm cùng 1 shard.
- **Search có scope site:** đặt `routing = site_id` → ES chỉ hỏi đúng shard đó (giảm ~8× tải).
- **Search kho dùng chung (`global`, theo `site_so_id`):** KHÔNG set routing → hỏi tất cả
  shard (chấp nhận, vì dữ liệu chung trải nhiều site).

> Tenant "khổng lồ" (1 Sở gom rất nhiều dữ liệu) có thể gây *hot shard*. Khi gặp, bật
> `index.routing_partition_size` để trải 1 routing value trên nhiều shard (yêu cầu
> `_routing` required). Hiện chưa bật để giữ linh hoạt cho truy vấn global.

## 3. Sharding & replica

- **Mặc định: 8 primary shard + 1 replica.**
- Công thức: nhắm mỗi shard **20–40GB**. Ước tính: doc denormalize ~2–4KB → 5 triệu doc
  ≈ 10–20GB. 8 shard cho dư địa tăng trưởng ~10× và phân tán nghìn tenant đều.
- **Không over-shard**: quá nhiều shard nhỏ → tốn heap, chậm. Muốn tăng → **reindex** sang
  index version mới nhiều shard hơn (alias `tvs_documents` chuyển nguội, zero-downtime).
- Replica ≥1 ở prod: vừa HA vừa tăng throughput đọc (search chạy cả trên replica).
  Dev single-node sẽ báo `yellow` (chưa gán replica) — bình thường.

## 4. Xếp hạng: `rank_feature` thay `function_score`

`function_score` phải tính điểm cho **từng** doc khớp → tốn ở quy mô triệu doc.
Dùng field type **`rank_feature`** — boost tích hợp trong Lucene, gần như miễn phí:

```
"popularity": { "type": "rank_feature" },   // = count_view
"rating":     { "type": "rank_feature" },   // = avg_score_rate
"downloads":  { "type": "rank_feature" }     // = count_download
```

Query cộng boost vào _score qua mệnh đề `should`:
```json
{ "rank_feature": { "field": "popularity", "log": { "scaling_factor": 4 } } }
{ "rank_feature": { "field": "rating",     "saturation": { "pivot": 4 } } }
```
> Giá trị `rank_feature` phải **> 0** → mapper chỉ ghi khi `count_view/rating/download > 0`
> (bằng 0 thì bỏ field, doc không được boost — đúng ý). Vẫn giữ `count_view` (integer)
> riêng để **hiển thị/sort**.

## 5. Autocomplete: `search_as_you_type`

`name.auto` kiểu `search_as_you_type` (kèm subfield `._2gram`, `._3gram`) → gợi ý tức thì
khi gõ, không quét prefix runtime:
```json
"name": { "type": "text", "analyzer": "vi_text",
  "fields": { "auto": { "type": "search_as_you_type", "analyzer": "vi_text" } } }
```
Suggest query: `multi_match` type `bool_prefix` trên `["name.auto","name.auto._2gram","name.auto._3gram"]`.

## 6. Kỷ luật field (giảm size, tăng tốc)

| Kỹ thuật | Áp dụng cho | Lợi ích |
|---|---|---|
| `index: false` | `cover_id, color, partner_id, partner_document_id, symbol_id` | Chỉ hiển thị, không tìm → bỏ khỏi inverted index, nhẹ hơn |
| `norms: false` + `index_options: freqs` | `full_desc, marc21_code` | Field dài, không cần scoring theo độ dài / không cần phrase → tiết kiệm nhiều |
| `eager_global_ordinals: true` | `category_ids, genre_ids, document_lang_id, khoi_ids, mon_ids, file_type_ids` | Facet (agg) nhanh hơn — build ordinals lúc refresh thay vì lúc query |
| **KHÔNG** eager, **KHÔNG** facet `terms` | `author_ids, publisher_id, tag_ids` | Cardinality cao (trăm nghìn giá trị) → `terms` agg ngốn RAM. Dùng như **filter + search**, không đếm facet |
| multi-field `name.sort` (keyword + `vi_keyword`) | sort A→Z không phân biệt dấu | Sort chuẩn tiếng Việt |

## 7. Tiếng Việt

- `vi_text` = `icu_tokenizer` + `lowercase` + `icu_folding` → tìm **không phân biệt dấu**
  ("toan" ↔ "toán"), chuẩn hóa Unicode.
- Nâng cấp tương lai nếu cần tách từ chính xác hơn (ghép "học sinh" thành 1 token):
  plugin `analysis-vietnamese` (coccoc) — đổi `tokenizer` trong `vi_text`, reindex.

## 8. Bản đồ field theo mục đích

> Đã đối chiếu DDL thật (`sql.sql` / digilib_production). Bảng dưới phản ánh schema thực tế.

| Nhóm | Field | Kiểu |
|---|---|---|
| Tenant (routing/filter) | `site_id, donvi_id, site_so_id` | keyword |
| Full-text | `name, other_name, short_desc, full_desc, subject, author_sub, publisher_name, marc21_code, meta_text` + `authors.name, categories.name, genres.name, tags.name` | text `vi_text` |
| Autocomplete | `name.auto` | search_as_you_type |
| Exact | `id, slug, issn, isbn, serial_number, identifier, so_tapchi` | keyword |
| Quan hệ có tên (mảng cặp) | `authors[{id,name}], categories[{id,name}], genres[{id,name}], tags[{id,name}]` | object: `.id` keyword + `.name` text |
| Phiếu (ticket) | `tickets[{id,code,name,type}]` | object: `.id/.code/.type` keyword + `.name` text |
| Filter (facet thấp) | `category_ids, genre_ids, document_lang_id, khoi_ids, mon_ids, file_type_ids` | keyword + eager |
| Filter (cardinality cao) | `author_ids, publisher_id, tag_ids, faculty_ids, major_ids, collection_ids, document_storage_ids, document_type_id` | keyword |
| Filter số | `is_tapchi, type_extra, status, status_share, loai_hinh_id, is_download, is_share` | integer/keyword |
| Sort/hiển thị | `paper_count, count_view, count_readed, count_download, count_like, count_comment, avg_score_rate, published_date, created_date, updated_date` | numeric/date |
| Hiển thị (varchar tự do) | `release_date` | keyword |
| Boost | `popularity, rating, downloads` | rank_feature |
| Chỉ hiển thị | `cover_id, color, partner_id, partner_document_id, symbol_id` | keyword `index:false` |

**Ghi chú khớp DDL:**
- `meta_text` gom giá trị từ `tvs_document_meta_extend` (metadata động EAV) → search được metadata tuỳ site.
- `file_type_ids` tách CSV từ `document_type_id` (loại tài liệu PDF/EPUB/SCORM/Video...).
- `khoi_ids`/`mon_ids` lấy từ `tvs_document_has_khoi_mon_hoc` (cột `khoi_mon_id` + `type` 1=khối/2=môn trên pivot).
- `release_date` là varchar tự do trong DDL → để keyword; sort thời gian dùng `published_date`/`created_date`.
- Denormalize KHÔNG lọc theo `status` pivot (default không nhất quán giữa các bảng).

## 8b. Phiếu (ticket) chứa ấn phẩm — "tìm theo tên phiếu ra ấn phẩm"

Ấn phẩm ↔ phiếu là N-N qua 5 loại (mượn/nhập/kiểm kê/thanh lý/đặt mua). Denormalize
**phẳng** vào document (không nested) để 1 query là ra:

- `ticket_ids` (keyword) — lọc "ấn phẩm trong phiếu X".
- `ticket_codes` (keyword) — tìm/lọc theo mã phiếu.
- `ticket_names` (text `vi_text`) — **tìm ấn phẩm theo TÊN phiếu** (`match ... operator=and`).
- `ticket_types` (keyword: `borrow|import|inventory|liquidation|preorder`) — lọc theo loại.

Nạp bằng 1 query UNION 5 pivot→master (`src/sync/queries.ts` → `tickets`), **loại phiếu đã
xoá** (`deleted=1`) và **dedup** để tránh phình. Kiểm kê không có `name` → dùng `code`.

**Cảnh báo đồng bộ (quan trọng):** khi phiếu đổi (tên / thêm-bớt ấn phẩm / trạng thái),
`tvs_document.updated_date` KHÔNG đổi → delta-sync theo document sẽ bỏ sót. Cần cho worker
theo dõi thêm `updated_date` của bảng phiếu + pivot rồi reindex `document_id` liên quan,
hoặc full-reindex định kỳ. (Áp dụng chung cho mọi quan hệ denormalize, nhưng phiếu biến
động cao nên đáng lưu ý nhất.)

Nếu về sau cần điều kiện **tương quan trong CÙNG một phiếu** (vd loại=mượn + tên + đang mượn)
→ chuyển 4 field trên sang 1 field `nested tickets: [{type,id,code,name,status}]`.

## 8c. Cập nhật thực thể dùng chung đổi tên (author/category/… )

Vì tên thực thể được **nhân bản** vào nhiều ấn phẩm, ta lưu quan hệ dạng **mảng cặp
`{id, name}`** (object) để có thể sửa đúng phần tử. Khi 1 thực thể đổi tên, thư viện số
gọi `POST /ingest/update-entity {type,id,name}` → search chạy **`_update_by_query`**:
tìm mọi doc có `<field>.id == id` và sửa `.name` (thực thể đơn như publisher/lang thì gán
thẳng `publisher_name`/`lang_name`). App **không phải push lại từng ấn phẩm** → giữ DB gốc nhẹ.

> Đây là lý do KHÔNG dùng 2 mảng rời `author_ids` + `author_names`: sẽ không map được
> id↔tên để sửa lẻ. Object `{id,name}` (không nested) vẫn cho phép filter `authors.id`
> và full-text `authors.name` độc lập, mà `_update_by_query` sửa được trên `_source`.

## 9. Nâng cấp cấu trúc mà không downtime

Mọi thay đổi mapping "phá vỡ" (đổi type, đổi analyzer, tăng shard) → tạo index version mới
(`tvs_documents_<ts>`), reindex, rồi chuyển alias `tvs_documents` (atomic). Đã hiện thực
trong `ElasticService.createVersionedIndex()` + `switchAlias()`.
