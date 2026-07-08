# Elasticsearch tùy biến — cài sẵn plugin analysis-icu để phân tích tiếng Việt
# (icu_tokenizer + icu_folding: tìm không phân biệt dấu, chuẩn hóa Unicode).
FROM docker.elastic.co/elasticsearch/elasticsearch:8.13.4

RUN bin/elasticsearch-plugin install --batch analysis-icu
