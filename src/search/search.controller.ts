import { Body, Controller, Get, Post } from '@nestjs/common';
import { ElasticService } from '../common/elastic/elastic.service';
import { SearchService } from './search.service';
import { SearchDto, SuggestDto } from './dto/search.dto';

@Controller()
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly elastic: ElasticService,
  ) {}

  /** Tìm kiếm chính — thay cho getListDocumentInPage. */
  @Post('search')
  search(@Body() dto: SearchDto) {
    return this.searchService.search(dto);
  }

  /** Autocomplete theo từ khoá — cải tiến so với suggest random hiện tại. */
  @Post('suggest')
  suggest(@Body() dto: SuggestDto) {
    return this.searchService.suggest(dto);
  }

  /** Đếm số lượng theo từng bộ lọc — thay getFilterBySearchAdvanced. */
  @Post('facets')
  facets(@Body() dto: SearchDto) {
    return this.searchService.facets(dto);
  }

  /** Health check cho Docker/monitoring. */
  @Get('healthz')
  async health() {
    let es = false;
    try {
      es = await this.elastic.client.ping();
    } catch {
      es = false;
    }
    return { status: es ? 'ok' : 'degraded', elasticsearch: es };
  }
}
