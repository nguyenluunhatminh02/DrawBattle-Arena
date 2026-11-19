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
  private readonly activeJobs = new Map<string, Promise<void>>();
  private readonly MAX_CONCURRENT = 3;

  constructor(private readonly prisma: PrismaService) {}

  async queueRender(replayId: string, strokes: any[], durationMs: number): Promise<string> {
    if (this.activeJobs.has(replayId)) {
      this.logger.debug(`Render already queued for ${replayId}`);
      return replayId;
    }

    if (this.activeJobs.size >= this.MAX_CONCURRENT) {
      this.logger.warn(`Max concurrent renders (${this.MAX_CONCURRENT}) reached, skipping ${replayId}`);
      return replayId;
    }

    const job = this.renderInWorker(replayId, strokes, durationMs)
      .catch(err => {
        this.logger.error(
          `Queued render failed for ${replayId}`,
          err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => {
        this.activeJobs.delete(replayId);
      });

    this.activeJobs.set(replayId, job);
    this.logger.log(`Queued render for replay ${replayId} (${this.activeJobs.size}/${this.MAX_CONCURRENT} active)`);
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
        if (this.activeJobs.has(replay.id)) {
          this.logger.debug(`Skipping ${replay.id} - already queued`);
          continue;
        }
        if (this.activeJobs.size >= this.MAX_CONCURRENT) {
          this.logger.warn(`Max concurrent reached, stopping batch`);
          break;
        }
        const job = this.renderInWorker(replay.id, replay.strokes as any[], replay.durationMs)
          .catch(err => {
            this.logger.error(`Failed to render replay ${replay.id}`, err instanceof Error ? err.message : String(err));
          })
          .finally(() => {
            this.activeJobs.delete(replay.id);
          });
        this.activeJobs.set(replay.id, job);
        await job;
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

      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error(`Worker timeout for ${replayId}`));
      }, 60_000);

      worker.on('message', async (result: Buffer | { error: string }) => {
        clearTimeout(timeout);
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

      worker.on('error', err => {
        clearTimeout(timeout);
        reject(err);
      });
      worker.on('exit', code => {
        clearTimeout(timeout);
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
