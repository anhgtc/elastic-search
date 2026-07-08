import { Module } from '@nestjs/common';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { IngestKeyGuard } from './ingest-key.guard';

@Module({
  controllers: [IngestController],
  providers: [IngestService, IngestKeyGuard],
})
export class IngestModule {}
