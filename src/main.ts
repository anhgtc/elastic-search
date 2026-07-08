import 'reflect-metadata';
import { join } from 'path';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppApiModule } from './app-api.module';
import { AppWorkerModule } from './app-worker.module';
import { ElasticService } from './common/elastic/elastic.service';
import { SyncService } from './sync/sync.service';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const mode = (process.env.APP_MODE || 'api').toLowerCase();

  if (mode === 'api') {
    const app = await NestFactory.create<NestExpressApplication>(AppApiModule);
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: false }),
    );
    app.enableCors();
    // Giao diện tìm kiếm demo (web/index.html) phục vụ tại '/'
    app.useStaticAssets(join(process.cwd(), 'web'));
    const prefix = process.env.API_PREFIX;
    if (prefix) app.setGlobalPrefix(prefix.replace(/^\/+/, ''));
    const port = parseInt(process.env.HTTP_PORT || '3000', 10);
    await app.listen(port);
    logger.log(`Search API + UI demo tại http://localhost:${port}/`);
    return;
  }

  if (mode === 'worker') {
    const app = await NestFactory.createApplicationContext(AppWorkerModule);
    app.enableShutdownHooks();
    logger.log('Sync worker đã khởi động (cron delta sync).');
    return; // giữ tiến trình sống nhờ cron + kết nối
  }

  if (mode === 'reindex') {
    const app = await NestFactory.createApplicationContext(AppWorkerModule);
    const elastic = app.get(ElasticService);
    const sync = app.get(SyncService);
    await elastic.waitReady();
    await sync.fullReindex();
    await app.close();
    logger.log('Reindex hoàn tất. Thoát.');
    process.exit(0);
  }

  logger.error(`APP_MODE không hợp lệ: "${mode}" (api|worker|reindex)`);
  process.exit(1);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap lỗi:', err);
  process.exit(1);
});
