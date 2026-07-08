import { Module } from '@nestjs/common';
import { SharedModule } from './shared.module';
import { SearchModule } from './search/search.module';
import { IngestModule } from './ingest/ingest.module';

/** Root module vai trò API: Search (đọc) + Ingest (ghi). Không cần MySQL. */
@Module({
  imports: [SharedModule, SearchModule, IngestModule],
})
export class AppApiModule {}
