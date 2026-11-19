import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { existsSync } from 'fs';

@Injectable()
export class ReplayWorker {
  private readonly logger = new Logger(ReplayWorker.name);
  private readonly renderDir = join(process.cwd(), 'public', 'replays');
  private isRendering = false;

  constructor(private readonly prisma: PrismaService) {}

  async queueRender(replayId: string, strokes: any[], durationMs: number): Promise<string> {
    this.logger.log(`Queued render for replay ${replayId}`);
    void this.renderInWorker(replayId, strokes, durationMs).catch(err => {
      this.logger.error(
        `Queued render failed for ${replayId}`,
        err instanceof Error ? err.message : String(err),
      );
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
          await this.renderInWorker(replay.id, replay.strokes as any[], replay.durationMs);
        } catch (err) {
          this.logger.error(`Failed to render replay ${replay.id}`, err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      this.isRendering = false;
    }
  }

  private renderInWorker(replayId: string, strokes: any[], durationMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const workerPath = join(__dirname, 'gif-worker.js');
      if (!existsSync(workerPath)) {
        reject(new Error(`gif-worker.js not found at ${workerPath}`));
        return;
      }

      const worker = new Worker(workerPath, {
        workerData: {
          strokes,
          durationMs,
          options: {
            width: 640,
            height: 400,
            fps: 10,
            backgroundColor: '#FFFFFF',
          },
        },
      });

      worker.on('message', async (result: Buffer | { error: string }) => {
        if (result && typeof result === 'object' && 'error' in result) {
          reject(new Error((result as { error: string }).error));
          return;
        }

        try {
          const gifBuffer = result as Buffer;
          await mkdir(this.renderDir, { recursive: true });

          const filename = `${replayId}.gif`;
          const filepath = join(this.renderDir, filename);
          await writeFile(filepath, gifBuffer);

          const gifUrl = `/replays/${filename}`;
          await this.prisma.replay.update({
            where: { id: replayId },
            data: { gifUrl },
          });

          this.logger.log(`Rendered replay ${replayId} -> ${gifUrl} (${gifBuffer.length} bytes)`);
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      worker.on('error', reject);
      worker.on('exit', code => {
        if (code !== 0) {
          reject(new Error(`Worker exited with code ${code}`));
        }
      });
    });
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
