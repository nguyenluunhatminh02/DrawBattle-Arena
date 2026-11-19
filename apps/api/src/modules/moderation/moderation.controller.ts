import { Controller, Get, Patch, Body, Param, Query } from '@nestjs/common';
import { ModerationService } from './moderation.service';

@Controller('moderation')
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Get('reports')
  getReports(@Query('status') status?: string, @Query('limit') limit?: string) {
    return this.moderationService.getReports(status, limit ? parseInt(limit, 10) : 50);
  }

  @Patch('reports/:id')
  updateReport(
    @Param('id') id: string,
    @Body() body: { status: string; action?: string; reason?: string },
  ) {
    return this.moderationService.updateReport(id, body.status, body.action, body.reason);
  }

  @Get('actions')
  getActions(@Query('limit') limit?: string) {
    return this.moderationService.getActions(limit ? parseInt(limit, 10) : 50);
  }

  @Get('stats')
  getStats() {
    return this.moderationService.getStats();
  }
}
