import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { renderStrokesToGif } from './gif-renderer';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';

@Injectable()
export class ReplayWorker {
  private readonly logger = new Logger(ReplayWorker.name);
  private readonly renderDir = join(process.cwd(), 'public', 'replays');
  private isRendering = false;

  constructor(private readonly prisma: PrismaService) {}

  async queueRender(replayId: string, strokes: any[], durationMs: number): Promise<string> {
    this.logger.log(`Queued render for replay ${replayId}`);
    setImmediate(() => {
      void this.processRender(replayId, strokes, durationMs).catch(err => {
        this.logger.error(
          `Queued render failed for ${replayId}`,
          err instanceof Error ? err.message : String(err),
        );
      });
    });
    return replayId;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async processPendingReplays() {
    if (this.isRendering) return;

    const pending = await this.prisma.replay.findMany({
      where: { gifUrl: null },
      take: 5,
      orderBy: { createdAt: 'asc' },
    });

    if (pending.length === 0) return;

    this.isRendering = true;
    this.logger.log(`Processing ${pending.length} pending replays`);

    try {
      for (const replay of pending) {
        try {
          await this.processRender(replay.id, replay.strokes as any[], replay.durationMs);
        } catch (err) {
          this.logger.error(`Failed to render replay ${replay.id}`, err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      this.isRendering = false;
    }
  }

  private async processRender(replayId: string, strokes: any[], durationMs: number) {
    try {
      await mkdir(this.renderDir, { recursive: true });

      const gifBuffer = await renderStrokesToGif(strokes, durationMs, {
        width: 640,
        height: 400,
        fps: 10,
        backgroundColor: '#FFFFFF',
      });

      const filename = `${replayId}.gif`;
      const filepath = join(this.renderDir, filename);
      await writeFile(filepath, gifBuffer);

      const gifUrl = `/replays/${filename}`;
      await this.prisma.replay.update({
        where: { id: replayId },
        data: { gifUrl },
      });

      this.logger.log(`Rendered replay ${replayId} -> ${gifUrl} (${gifBuffer.length} bytes)`);
    } catch (err) {
      this.logger.error(`Render failed for ${replayId}`, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async cleanupOldReplays(maxAgeDays = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);

    const old = await this.prisma.replay.findMany({
      where: { createdAt: { lt: cutoff }, gifUrl: { not: null } },
      select: { id: true, gifUrl: true },
    });

    let deleted = 0;
    for (const replay of old) {
      if (replay.gifUrl) {
        const filepath = join(process.cwd(), 'public', replay.gifUrl);
        try {
          await unlink(filepath);
          deleted++;
        } catch {}
      }
    }

    this.logger.log(`Cleaned up ${deleted} old replay GIFs`);
    return { deleted };
  }
}
