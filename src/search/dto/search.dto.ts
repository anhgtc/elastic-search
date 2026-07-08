import { IsOptional } from 'class-validator';

/**
 * DTO nhận ĐÚNG bộ tham số mà FE Thư Viện Số đang gửi cho
 * getListDocumentInPage -> giai đoạn tích hợp sau chỉ cần đổi URL.
 * Giá trị id có thể là 1 chuỗi hoặc mảng chuỗi (service tự chuẩn hoá).
 */
export class SearchDto {
  // Bối cảnh multi-tenant (bắt buộc site_id)
  @IsOptional() site_id?: string;
  @IsOptional() donvi_id?: string;
  @IsOptional() site_so_id?: string;
  @IsOptional() global?: boolean | string;

  // Từ khoá
  @IsOptional() t?: string;

  // Bộ lọc
  @IsOptional() cate_id?: string | string[];
  @IsOptional() ge_id?: string | string[];
  @IsOptional() au_id?: string | string[];
  @IsOptional() pub_id?: string | string[];
  @IsOptional() collect_id?: string | string[];
  @IsOptional() lang_id?: string | string[];
  @IsOptional() tag_id?: string | string[];
  @IsOptional() khoi_id?: string | string[];
  @IsOptional() mon_id?: string | string[];
  @IsOptional() faculty_id?: string | string[];
  @IsOptional() major_id?: string | string[];
  @IsOptional() document_storage_id?: string | string[];
  @IsOptional() ft_id?: string | string[]; // loại file (khớp file_type_ids khi bật)
  @IsOptional() loai_hinh_id?: string | number; // is_tapchi (1/2/3)
  @IsOptional() type_extra?: string | number; // 1 điện tử / 2 giấy / 3 cả hai
  @IsOptional() status_id?: string | number; // trạng thái document (mặc định 1)

  // Lọc/tìm theo phiếu chứa ấn phẩm
  @IsOptional() ticket_id?: string | string[];
  @IsOptional() ticket_code?: string | string[];
  @IsOptional() ticket_type?: string | string[]; // borrow|import|inventory|liquidation|preorder
  @IsOptional() ticket_name?: string; // tìm ấn phẩm theo TÊN phiếu

  // Sắp xếp & phân trang
  @IsOptional() s?: string; // name_asc | paper_count | newest
  @IsOptional() page?: string | number;
  @IsOptional() limit?: string | number;
}

export class SuggestDto {
  @IsOptional() site_id?: string;
  @IsOptional() donvi_id?: string;
  @IsOptional() t?: string;
  @IsOptional() limit?: string | number;
}
