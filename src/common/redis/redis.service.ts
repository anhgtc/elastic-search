import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis lưu checkpoint đồng bộ (mốc updated_date lần sync trước) và cache suggest.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;
  private prefix = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const cfg = this.config.get('redis') as any;
    this.prefix = cfg.keyPrefix || '';
    this.client = new Redis({
      host: cfg.host,
      port: cfg.port,
      password: cfg.password || undefined,
      db: cfg.db,
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });
    this.client.on('error', (err) =>
      this.logger.error(`Redis error: ${err.message}`),
    );
    this.logger.log(`Redis khởi tạo -> ${cfg.host}:${cfg.port} db=${cfg.db}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.quit();
  }

  private k(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(this.k(key));
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.set(this.k(key), value, 'EX', ttlSeconds);
    } else {
      await this.client.set(this.k(key), value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(this.k(key));
  }
}
