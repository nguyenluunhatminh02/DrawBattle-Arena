import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ReplayJobService } from './replay-jobs';

@Injectable()
export class ReplayService {
  private readonly logger = new Logger(ReplayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ReplayJobService,
  ) {}

  async getReplay(replayId: string) {
    const replay = await this.prisma.replay.findUnique({ where: { id: replayId } });
    if (!replay) throw new NotFoundException('Replay not found');
    return replay;
  }

  async getReplayByTurn(turnId: string) {
    const replay = await this.prisma.replay.findUnique({ where: { turnId } });
    if (!replay) throw new NotFoundException('Replay not found for turn');
    return replay;
  }

  async queueRender(replayId: string) {
    return this.jobs.queueReplay(replayId);
  }

  async getJobStatus(jobId: string) {
    return this.jobs.getStatus(jobId);
  }

  async getRenderStatus(replayId: string) {
    return this.jobs.getStatusByReplay(replayId);
  }

  async getGif(replayId: string) {
    const replay = await this.getReplay(replayId);
    const job = await this.jobs.getJobByReplay(replayId);
    const gifUrl = this.jobs.assertRendered(replay, job);
    return gifUrl;
  }

  async updateGifUrl(replayId: string, gifUrl: string) {
    return this.prisma.replay.update({
      where: { id: replayId },
      data: { gifUrl },
    });
  }

  async getStats() {
    const total = await this.prisma.replay.count();
    const rendered = await this.prisma.replay.count({ where: { gifUrl: { not: null } } });
    return {
      total,
      rendered,
      pending: await this.jobs.pendingCount(),
      unrendered: total - rendered,
    };
  }
}
