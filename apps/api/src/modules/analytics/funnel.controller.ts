import { Body, Controller, Get, Post } from '@nestjs/common';
import { FunnelService } from './funnel.service';

@Controller('analytics')
export class FunnelController {
  constructor(private readonly funnel: FunnelService) {}

  @Post('event')
  track(@Body() body: { event: string; sessionId?: string; data?: Record<string, unknown> }) {
    return this.funnel.track(body.event, body.sessionId, body.data);
  }

  @Get('summary')
  summary() {
    return this.funnel.summary();
  }
}
