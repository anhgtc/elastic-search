# TVS Search Service

Hệ thống tìm kiếm **độc lập** cho Thư Viện Số, dùng **Elasticsearch**. search
**KHÔNG chạm vào DB của thư viện số** — chỉ là một service nhận dữ liệu qua API và
phục vụ tìm kiếm. Hai mặt API:

1. **Ingest (ghi):** bên thư viện số **PUSH** document đầy đủ vào (`POST/DELETE /ingest/documents`).
2. **Search (đọc):** `POST /search`, `/suggest`, `/facets` + giao diện demo tại `/`.

Toàn bộ cấu hình qua `.env` → **có hạ tầng chỉ việc điền `.env` là chạy**.

---

## 1. Kiến trúc

```
Thư viện số ──(PUSH payload đầy đủ)──> [search-api /ingest] ──bulk──> Elasticsearch
                                                                          ▲
                                            [search-api /search] ◄── FE/BE│ query
                                                                       [Redis] (cache suggest)
```

- **Chế độ chính `APP_MODE=api`**: Search + Ingest, **không cần MySQL**.
- **Tùy chọn PULL** (`APP_MODE=worker|reindex`): nếu muốn search tự đọc MySQL gốc (READ-ONLY)
  thay vì được push — chạy qua profile `pull`. Không bật mặc định.
- **Zero-downtime reindex:** index vật lý đánh version (`tvs_documents_<ts>`), API luôn
  query qua alias `tvs_documents`; reindex xong mới chuyển alias (atomic) và xoá index cũ.
- **Tiếng Việt:** analyzer `icu_tokenizer + icu_folding` (tìm không phân biệt dấu).

## 2. Yêu cầu

- Docker + Docker Compose (khuyến nghị). Hoặc Node.js 20+ để chạy trực tiếp.
- Quyền truy cập MySQL gốc (chỉ cần `SELECT`).

## 3. Chạy DEV (kèm ES + Kibana local — thử ngay)

```bash
cp .env.example .env
# Sửa MYSQL_* trỏ tới DB gốc (dev có thể dùng host.docker.internal)
# Để ELASTIC_NODE=http://elasticsearch:9200 (ES trong compose)

docker compose --profile dev up -d --build
```

- API: http://localhost:3000/search
- Kibana: http://localhost:5601
- Elasticsearch: http://localhost:9200

Worker sẽ tự **full reindex lần đầu** (nếu alias chưa có) rồi chạy **delta mỗi phút**.

## 4. Chạy PROD (cắm hạ tầng cấp sau)

Khi có ES hạ tầng riêng, **không cần** container `elasticsearch`/`kibana`:

```bash
# .env: trỏ ELASTIC_NODE + ELASTIC_USERNAME/PASSWORD ra ES thật
docker compose up -d --build     # chỉ chạy search-api + sync-worker + redis
```

## 5. Full reindex thủ công

```bash
docker compose run --rm reindex
```

## 6. Biến môi trường chính (`.env`)

| Nhóm | Biến | Ý nghĩa |
|---|---|---|
| Vai trò | `APP_MODE` | `api` / `worker` / `reindex` |
| MySQL | `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE` | Nguồn dữ liệu (READ-ONLY) |
| ES | `ELASTIC_NODE/USERNAME/PASSWORD` | Đích ES; prod trỏ ra hạ tầng ngoài |
| ES | `ELASTIC_INDEX_ALIAS` | Alias query (mặc định `tvs_documents`) |
| Redis | `REDIS_HOST/PORT/PASSWORD` | Lưu cache suggest |
| Ingest | `INGEST_API_KEY` | Khóa bảo vệ API ghi (header `X-Ingest-Key`). Trống = mở (dev) |
| Sync (tùy chọn) | `SYNC_CRON/SYNC_BATCH_SIZE/SYNC_DEPS_ENABLED` | Chỉ dùng cho chế độ PULL |

## 7. API

### Ingest (GHI) — bên thư viện số PUSH cập nhật vào
Bảo vệ bằng header `X-Ingest-Key` (nếu `INGEST_API_KEY` được đặt).

```bash
# Thêm/cập nhật (upsert) — gửi document ĐẦY ĐỦ (đã denormalize)
# Quan hệ có tên lưu dạng MẢNG CẶP {id,name}: authors/categories/genres/tags;
# phiếu: tickets [{id,code,name,type}].
curl -X POST http://localhost:3000/ingest/documents \
  -H 'Content-Type: application/json' -H 'X-Ingest-Key: <key>' -d '{
  "refresh": true,
  "documents": [
    { "id":"d123", "site_id":"s1", "status":1, "name":"Toán 5",
      "authors":[{"id":"a1","name":"Nguyễn Văn A"}],
      "categories":[{"id":"c1","name":"Giáo khoa"}],
      "tickets":[{"id":"t9","code":"NS9","name":"Phiếu nhập tháng 9","type":"import"}],
      "count_view":10, "popularity":10 }
  ]
}'

# Xoá
curl -X DELETE http://localhost:3000/ingest/documents \
  -H 'Content-Type: application/json' -H 'X-Ingest-Key: <key>' -d '{
  "refresh": true, "documents": [ { "id":"d123", "site_id":"s1" } ] }'

# ⭐ Đổi tên 1 THỰC THỂ dùng chung -> search TỰ cập nhật mọi ấn phẩm chứa nó
# (app chỉ gửi type/id/name, KHÔNG phải push lại từng ấn phẩm)
# type: author | category | genre | tag | publisher | lang | ticket
curl -X POST http://localhost:3000/ingest/update-entity \
  -H 'Content-Type: application/json' -H 'X-Ingest-Key: <key>' -d '{
  "type":"author", "id":"a5", "name":"Nguyễn Du (đại thi hào)", "refresh":true }'
```
- `id` bắt buộc; `site_id` dùng để **routing** (định tuyến shard) — nên gửi kèm cả khi xoá.
- `refresh:true` → thấy ngay trong search (mặc định false, thấy sau ~refresh_interval).
- Payload là document phẳng khớp mapping (xem `docs/INDEX_DESIGN.md`). Field lạ bị bỏ qua.
- Index tự tạo ở lần ingest đầu (mapping + alias).
- **`update-entity`** dùng `_update_by_query` sửa đúng phần tử theo `id` trong mọi ấn phẩm →
  trả `{matched, updated}`. Với thực thể có trong RẤT nhiều ấn phẩm, thao tác nặng nhưng hiếm.

### `POST /search`
Nhận đúng tham số FE đang dùng (`t`, `cate_id`, `au_id`, `ge_id`, `pub_id`, `collect_id`,
`lang_id`, `tag_id`, `khoi_id`, `mon_id`, `faculty_id`, `major_id`, `document_storage_id`,
`ft_id`, `loai_hinh_id`, `type_extra`, `s`, `page`, `limit`). **Bắt buộc `site_id`.**

```bash
curl -X POST http://localhost:3000/search -H 'Content-Type: application/json' -d '{
  "site_id": "xxxx", "donvi_id": "yyyy",
  "t": "toan lop 5", "s": "newest", "page": 1, "limit": 18
}'
```

Trả về: `{ data: [...], paging: { page, limit, total, total_pages }, meta }`.

### `POST /suggest`
Autocomplete theo từ khoá (`site_id`, `t`, `limit`). Có cache Redis 5 phút.

### `POST /facets`
Đếm số lượng theo từng bộ lọc (category/genre/author/publisher/language/tag/type_extra/is_tapchi).

### `GET /healthz`
Health check (ping ES).

## 8. ⚠️ Cần đối chiếu schema trước khi lên prod

Scaffold suy tên cột pivot theo quy ước `<entity>_id` (đã xác nhận qua
`tvs_document_has_author.author_id`). Hãy đối chiếu `db/mysql/node1/init/backup.sql`
cho các bảng còn lại và sửa trong `src/sync/queries.ts` nếu khác:

- `tvs_document_has_{category,genre,tag,collection,faculty,major}` → cột `<entity>_id`
- `tvs_document_has_khoi_mon_hoc.khoi_mon_hoc_id`
- **`file_type_ids`**: chưa xác định nguồn (từ `tvs_document_content`/mapping nghiệp vụ).
  Hiện để rỗng; filter `ft_id` chưa hiệu lực. Xem chú thích trong `document-mapper.ts`.
- **Kho dùng chung (`global`/`site_so_id`)**: field đã có trong mapping nhưng worker chưa
  nạp `site_so_id`; cần bổ sung join `tvs_document_shared` khi triển khai tính năng này.

## 9. Lộ trình tích hợp (giai đoạn sau)

Search service chạy độc lập trước. Khi ổn định, chọn 1 trong 2 cách tích hợp:
- FE gọi thẳng `search-api` cho trang tìm kiếm/bạn đọc.
- BE PHP thêm 1 adapter mỏng proxy `getListDocumentInPage` → `search-api` (không đổi FE).

## 10. Cấu trúc thư mục

```
search-service/
├── docker-compose.yml          # profiles: dev / tools
├── Dockerfile                  # image app (Node 20)
├── .env.example
├── elasticsearch/
│   ├── Dockerfile              # ES 8 + plugin analysis-icu
│   └── documents.mapping.json  # mapping + analyzer tiếng Việt
└── src/
    ├── main.ts                 # chọn vai trò theo APP_MODE
    ├── config/configuration.ts
    ├── common/{elastic,mysql,redis}/
    ├── sync/                   # worker: queries + mapper + delta/full reindex
    └── search/                 # API: controller + service + dto
```
