import { Module } from '@nestjs/common';
import { SharedModule } from './shared.module';
import { MysqlModule } from './common/mysql/mysql.module';
import { SyncModule } from './sync/sync.module';

/**
 * Root module cho vai trò PULL tùy chọn (APP_MODE=worker|reindex).
 * Chỉ chế độ này mới cần MySQL (đọc DB gốc). Không dùng ở chế độ api.
 */
@Module({
  imports: [SharedModule, MysqlModule, SyncModule],
})
export class AppWorkerModule {}
