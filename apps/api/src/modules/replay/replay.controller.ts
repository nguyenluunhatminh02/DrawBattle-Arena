import { Controller, Get, Post, Param, Res } from '@nestjs/common';
import { ReplayService } from './replay.service';
import { Throttle } from '../../common/throttle.guard';
import type { Response } from 'express';

@Controller('replays')
export class ReplayController {
  constructor(private readonly replayService: ReplayService) {}

  @Get(':id')
  async getReplay(@Param('id') id: string) {
    return this.replayService.getReplay(id);
  }

  @Get('turn/:turnId')
  async getByTurn(@Param('turnId') turnId: string) {
    return this.replayService.getReplayByTurn(turnId);
  }

  @Post(':id/render')
  @Throttle({ limit: 3, windowMs: 60_000, keyPrefix: 'replay-render' })
  async queueRender(@Param('id') id: string) {
    return this.replayService.queueRender(id);
  }

  @Get(':id/gif')
  async getGif(@Param('id') id: string, @Res() res: Response) {
    const replay = await this.replayService.getReplay(id);
    if (!replay.gifUrl) {
      return res.status(404).json({ message: 'GIF not yet rendered' });
    }
    return res.redirect(replay.gifUrl);
  }

  @Get()
  async stats() {
    return this.replayService.getStats();
  }
}
