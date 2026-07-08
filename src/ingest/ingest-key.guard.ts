import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Bảo vệ các endpoint GHI (ingest) bằng header `X-Ingest-Key`.
 * Nếu INGEST_API_KEY để trống -> cho qua (tiện cho dev). Prod nên đặt khóa.
 */
@Injectable()
export class IngestKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = (this.config.get('ingest') as any)?.apiKey || '';
    if (!expected) return true; // chưa cấu hình khóa -> mở (dev)

    const req = context.switchToHttp().getRequest();
    const got = req.headers['x-ingest-key'];
    if (got !== expected) {
      throw new UnauthorizedException('X-Ingest-Key không hợp lệ');
    }
    return true;
  }
}
