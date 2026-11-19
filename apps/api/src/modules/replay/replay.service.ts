import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ReplayWorker } from './replay.worker';

@Injectable()
export class ReplayService {
  private readonly logger = new Logger(ReplayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: ReplayWorker,
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

  async queueRender(replayId: string): Promise<{ jobId: string; status: string }> {
    const replay = await this.prisma.replay.findUnique({ where: { id: replayId } });
    if (!replay) throw new NotFoundException('Replay not found');

    if (replay.gifUrl) {
      return { jobId: replayId, status: 'already_rendered' };
    }

    const jobId = await this.worker.queueRender(
      replayId,
      replay.strokes as any[],
      replay.durationMs,
    );
    return { jobId, status: 'queued' };
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
    const pending = total - rendered;
    return { total, rendered, pending };
  }
}
