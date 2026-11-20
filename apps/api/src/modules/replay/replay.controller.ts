import { Controller, Get, Post, Param, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { ReplayService } from './replay.service';
import { Throttle } from '../../common/throttle.guard';
import type { Response } from 'express';

@Controller('replays')
export class ReplayController {
  constructor(private readonly replayService: ReplayService) {}

  // Specific routes must be declared before /:id so Nest does not shadow them.
  @Get('stats')
  async stats() {
    return this.replayService.getStats();
  }

  @Get('turn/:turnId')
  async getByTurn(@Param('turnId') turnId: string) {
    return this.replayService.getReplayByTurn(turnId);
  }

  // Render status is cheap and can be polled after receiving 202 from /render.
  @Get(':id/render/status')
  @Throttle({ limit: 60, windowMs: 60_000, keyPrefix: 'replay-render-status' })
  async getRenderStatus(@Param('id') id: string) {
    return this.replayService.getRenderStatus(id);
  }

  @Get('jobs/:jobId')
  @Throttle({ limit: 60, windowMs: 60_000, keyPrefix: 'replay-job-status' })
  async getJobStatus(@Param('jobId') jobId: string) {
    return this.replayService.getJobStatus(jobId);
  }

  @Post(':id/render')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ limit: 3, windowMs: 60_000, keyPrefix: 'replay-render' })
  async queueRender(@Param('id') id: string) {
    return this.replayService.queueRender(id);
  }

  @Get(':id/gif')
  async getGif(@Param('id') id: string, @Res() res: Response) {
    const gifUrl = await this.replayService.getGif(id);
    return res.redirect(gifUrl);
  }

  @Get(':id')
  async getReplay(@Param('id') id: string) {
    return this.replayService.getReplay(id);
  }
}
