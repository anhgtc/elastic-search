import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';

/**
 * Kết nối MySQL gốc CHỈ ĐỌC. Không tạo/sửa dữ liệu ở đây.
 * Cung cấp helper query() trả về mảng row.
 */
@Injectable()
export class MysqlService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MysqlService.name);
  private pool!: mysql.Pool;
  private prefix = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const cfg = this.config.get('mysql') as any;
    this.prefix = cfg.tablePrefix || '';
    this.pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectionLimit: cfg.connectionLimit,
      waitForConnections: true,
      charset: 'utf8mb4',
      dateStrings: true, // giữ nguyên chuỗi 'YYYY-MM-DD HH:mm:ss' cho ES
      namedPlaceholders: true,
    });
    this.logger.log(
      `MySQL pool khởi tạo -> ${cfg.host}:${cfg.port}/${cfg.database} (READ-ONLY)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) await this.pool.end();
  }

  /** Thêm tiền tố bảng nếu có cấu hình (mặc định rỗng). */
  table(name: string): string {
    return `${this.prefix}${name}`;
  }

  async query<T = any>(
    sql: string,
    params: Record<string, any> | any[] = [],
  ): Promise<T[]> {
    const [rows] = await this.pool.query(sql, params);
    return rows as T[];
  }

  async ping(): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.ping();
    } finally {
      conn.release();
    }
  }
}
