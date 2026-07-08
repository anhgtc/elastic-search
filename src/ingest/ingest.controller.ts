import { Body, Controller, Delete, Post, UseGuards } from '@nestjs/common';
import { IngestService } from './ingest.service';
import {
  IngestUpsertDto,
  IngestDeleteDto,
  UpdateEntityDto,
} from './dto/ingest.dto';
import { IngestKeyGuard } from './ingest-key.guard';

/**
 * API GHI — bên thư viện số PUSH cập nhật vào search.
 * search KHÔNG đọc DB gốc; toàn bộ dữ liệu đến từ payload.
 */
@UseGuards(IngestKeyGuard)
@Controller('ingest')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  /** Thêm/cập nhật (upsert) document. Body: { documents: [...], refresh?: bool } */
  @Post('documents')
  upsert(@Body() body: IngestUpsertDto) {
    return this.ingest.upsert(body.documents, body.refresh ?? false);
  }

  /** Xoá document. Body: { documents: [{id, site_id}], refresh?: bool } */
  @Delete('documents')
  remove(@Body() body: IngestDeleteDto) {
    return this.ingest.remove(body.documents, body.refresh ?? false);
  }

  /**
   * Cập nhật 1 thực thể đổi tên (tác giả/danh mục/…) -> sửa mọi ấn phẩm chứa nó.
   * Body: { type, id, name, refresh? }
   */
  @Post('update-entity')
  updateEntity(@Body() body: UpdateEntityDto) {
    return this.ingest.updateEntity(
      body.type,
      body.id,
      body.name,
      body.refresh ?? false,
    );
  }
}
