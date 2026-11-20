import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { FunnelService } from './funnel.service';
import { AdminGuard } from '../../common/admin.guard';

@Controller('analytics')
export class FunnelController {
  constructor(private readonly funnel: FunnelService) {}

  // Public tracking endpoint: must remain reachable by every visitor.
  @Post('event')
  track(@Body() body: { event: string; sessionId?: string; data?: Record<string, unknown> }) {
    return this.funnel.track(body.event, body.sessionId, body.data);
  }

  // Aggregated funnel data is admin-only.
  @Get('summary')
  @UseGuards(AdminGuard)
  summary() {
    return this.funnel.summary();
  }
}
