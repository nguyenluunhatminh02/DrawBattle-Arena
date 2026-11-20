import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { FunnelService } from './funnel.service';
import { AdminGuard } from '../../common/admin.guard';
import { Throttle } from '../../common/throttle.guard';

@Controller('analytics')
export class FunnelController {
  constructor(private readonly funnel: FunnelService) {}

  // Public tracking endpoint: must remain reachable by every visitor.
  @Post('event')
  @Throttle({ limit: 120, windowMs: 60_000, keyPrefix: 'analytics-event' })
  track(@Body() body: { event?: unknown; sessionId?: unknown; data?: unknown }) {
    const payload = body ?? {};
    return this.funnel.track(
      typeof payload.event === 'string' ? payload.event : '',
      typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
      payload.data as Record<string, unknown> | undefined,
    );
  }

  // Aggregated funnel data is admin-only.
  @Get('summary')
  @UseGuards(AdminGuard)
  summary() {
    return this.funnel.summary();
  }
}
