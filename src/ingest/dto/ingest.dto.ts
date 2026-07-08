import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

/**
 * Upsert: nhận mảng document ĐẦY ĐỦ (đã denormalize) từ bên thư viện số.
 * Mỗi document bắt buộc có `id`; nên có `site_id` để routing theo tenant.
 * Các field khác khớp mapping (name, author_names, ticket_names, ...).
 */
export class IngestUpsertDto {
  @IsArray() documents!: Record<string, any>[];
  @IsOptional() @IsBoolean() refresh?: boolean; // true = thấy ngay trong search
}

/** Mỗi phần tử xoá cần id (+ site_id để định tuyến đúng shard). */
export class IngestDeleteDto {
  @IsArray() documents!: { id: string; site_id?: string }[];
  @IsOptional() @IsBoolean() refresh?: boolean;
}

/**
 * Cập nhật 1 THỰC THỂ dùng chung (tác giả/danh mục/thể loại/tag/NXB/ngôn ngữ/phiếu)
 * đổi tên -> search tự sửa MỌI ấn phẩm chứa nó bằng _update_by_query.
 * Bên thư viện số chỉ cần gửi { type, id, name } — không phải push lại từng ấn phẩm.
 */
export class UpdateEntityDto {
  @IsString() type!:
    | 'author'
    | 'category'
    | 'genre'
    | 'tag'
    | 'publisher'
    | 'lang'
    | 'ticket';
  @IsString() id!: string;
  @IsString() name!: string;
  @IsOptional() @IsBoolean() refresh?: boolean;
}
