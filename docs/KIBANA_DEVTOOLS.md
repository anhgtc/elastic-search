# Kibana Dev Tools — Cheat Sheet cho `tvs_documents`

**Mở:** http://localhost:5601 → menu (☰) → **Dev Tools** (hoặc vào thẳng
`http://localhost:5601/app/dev_tools#/console`). Đặt con trỏ vào 1 lệnh rồi bấm ▶ hoặc
**Ctrl/Cmd + Enter** để chạy. Gõ tiếng Việt có dấu thoải mái (Kibana là UTF-8).

> `tvs_documents` là **alias** (đang trỏ tới index vật lý `tvs_documents_v4`).
> Index dùng **custom routing = `site_id`** → khi lấy 1 doc theo id phải kèm `?routing=<site_id>`.

## 1. Tổng quan / kiểm tra
```
GET _cluster/health
GET _cat/indices/tvs_documents*?v
GET _cat/aliases/tvs_documents?v
GET tvs_documents/_count
GET tvs_documents/_mapping
```

## 2. Xem dữ liệu
```
# 10 document đầu
GET tvs_documents/_search

# Chỉ lấy vài field + tăng size
GET tvs_documents/_search
{ "_source": ["id","name","count_view","ticket_names"], "size": 20 }

# 1 document theo id (BẮT BUỘC kèm routing = site_id)
GET tvs_documents/_doc/d1?routing=site1
```

## 3. Tìm kiếm full-text (không phân biệt dấu)
```
GET tvs_documents/_search
{ "query": { "multi_match": {
    "query": "toan", "fuzziness": "AUTO", "prefix_length": 2,
    "fields": ["name^5","other_name^4","authors.name^3","subject^2","categories.name","short_desc","full_desc","meta_text"]
} } }
```

## 4. Lọc (filter context) + multi-tenant
```
GET tvs_documents/_search
{ "query": { "bool": { "filter": [
    { "term":  { "site_id": "site1" } },
    { "term":  { "status": 1 } },
    { "terms": { "categories.id": ["c3"] } },
    { "terms": { "file_type_ids": ["pdf"] } }
] } } }
```

## 5. Tìm ấn phẩm theo TÊN phiếu
```
GET tvs_documents/_search
{ "query": { "match": { "tickets.name": { "query": "nhập tháng 9", "operator": "and" } } } }
```

## 6. Sắp xếp
```
GET tvs_documents/_search
{ "sort": [ { "count_view": "desc" } ], "_source": ["name","count_view"] }
```

## 7. Facet — đếm theo nhóm (cardinality thấp)
```
GET tvs_documents/_search
{ "size": 0, "aggs": {
    "theo_loai_file": { "terms": { "field": "file_type_ids" } },
    "theo_ngon_ngu":  { "terms": { "field": "document_lang_id" } },
    "theo_loai_phieu":{ "terms": { "field": "tickets.type" } }
} }
```

## 8. Kiểm tra analyzer tiếng Việt (icu_folding)
```
POST tvs_documents/_analyze
{ "field": "name", "text": "Toán học lớp 5" }
# -> tokens: toan | hoc | lop | 5   (bỏ dấu)
```

## 9. Autocomplete (search_as_you_type)
```
GET tvs_documents/_search
{ "query": { "multi_match": {
    "query": "toa", "type": "bool_prefix",
    "fields": ["name.auto","name.auto._2gram","name.auto._3gram"] } },
  "_source": ["name"] }
```

## 10. Boost độ phổ biến (rank_feature)
```
GET tvs_documents/_search
{ "query": { "bool": {
    "must":   [ { "match": { "name": "toan" } } ],
    "should": [
      { "rank_feature": { "field": "popularity", "log": { "scaling_factor": 4 } } },
      { "rank_feature": { "field": "rating",     "saturation": { "pivot": 4 } } }
] } } }
```

## Mẹo
- Chỉ query 1 tenant → thêm routing để chạm 1 shard: `GET tvs_documents/_search?routing=site1`
- Đổi index vật lý sau reindex: xem `GET _cat/aliases/tvs_documents?v`
- Autocomplete/Discover trực quan: Kibana → **Discover** (tạo Data View trỏ `tvs_documents`).
