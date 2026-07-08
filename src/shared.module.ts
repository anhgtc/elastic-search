import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { ElasticModule } from './common/elastic/elastic.module';
import { RedisModule } from './common/redis/redis.module';

/**
 * Hạ tầng dùng chung: Config + Elasticsearch + Redis.
 * KHÔNG gồm MySQL — search-service không chạm DB thư viện số.
 * (MySQL chỉ được import ở AppWorkerModule cho chế độ PULL tùy chọn.)
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ElasticModule,
    RedisModule,
  ],
})
export class SharedModule {}
