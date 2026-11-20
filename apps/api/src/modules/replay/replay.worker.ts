import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { existsSync } from 'fs';
import { RenderJobRecord, ReplayJobService } from './replay-jobs';

@Injectable()
export class ReplayWorker {
  private readonly logger = new Logger(ReplayWorker.name);
  private readonly renderDir = join(process.cwd(), 'public', 'replays');
  private readonly activeJobs = new Map<string, Promise<void>>();
  private readonly MAX_CONCURRENT = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ReplayJobService,
  ) {}

  /**
   * Public queue path. The job service performs the atomic state transition
   * before any worker starts, so repeated calls cannot duplicate a render.
   */
  async queueRender(replayId: string, strokes: any[], durationMs: number) {
    return this.jobs.queueReplay(replayId);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processPendingReplays() {
    await this.jobs.recoverStale();

    for (let slot = this.activeJobs.size; slot < this.MAX_CONCURRENT; slot++) {
      const claimed = await this.jobs.claimNextJob();
      if (!claimed) break;
      this.startJob(claimed);
    }
  }

  /** Compensating cleanup for workers still in memory after a long outage. */
  async recoverStaleJobs() {
    await this.jobs.recoverStale();
  }

  private startJob(job: RenderJobRecord) {
    const task = this.executeJob(job)
      .catch(err => {
        this.logger.error(
          `Render job ${job.id} failed`,
          err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => {
        this.activeJobs.delete(job.id);
      });
    this.activeJobs.set(job.id, task);
  }

  private async executeJob(job: RenderJobRecord) {
    const replay = await this.prisma.replay.findUnique({ where: { id: job.replayId } });
    if (!replay) {
      await this.jobs.fail(job.id, 'Replay no longer exists');
      return;
    }
    try {
      await this.renderInWorker(job.id, job.replayId, replay.strokes as any[], replay.durationMs);
      await this.jobs.succeed(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.jobs.fail(job.id, message);
    }
  }

  private renderInWorker(jobId: string, replayId: string, strokes: any[], durationMs: number): Promise<void> {
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
        reject(new Error(`Worker timeout for ${jobId}`));
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

          this.logger.log(`Rendered replay ${jobId} -> ${gifUrl} (${gifBuffer.length} bytes)`);
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
