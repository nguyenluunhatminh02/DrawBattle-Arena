import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { basename, join } from 'path';
import { Worker } from 'worker_threads';
import { existsSync } from 'fs';
import { RenderJobRecord, ReplayJobService } from './replay-jobs';

const RENDER_TIMEOUT_MS = 60_000;
const RECONCILE_BATCH_SIZE = 100;
const REPLAY_URL_PREFIX = '/replays/';
const SHUTDOWN_ERROR = 'Replay worker shut down during render';

@Injectable()
export class ReplayWorker implements OnModuleDestroy {
  private readonly logger = new Logger(ReplayWorker.name);
  private readonly renderDir = join(process.cwd(), 'public', 'replays');
  private readonly activeJobs = new Map<string, Promise<void>>();
  private readonly activeWorkers = new Map<string, Worker>();
  private readonly MAX_CONCURRENT = 3;
  private shuttingDown = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ReplayJobService,
  ) {}

  /**
   * Public queue path. The job service only enqueues; this worker claims and
   * executes the job. Repeated calls cannot duplicate a render because
   * activeJobs is keyed by job id and claimNext is atomic.
   *
   * Immediate startup is intentionally limited to callers that reach this
   * method: the controller and game-state go through ReplayService ->
   * ReplayJobService.queueReplay, and injecting this worker back into the job
   * service would create a cycle. Those jobs start on the minute cron below.
   */
  async queueRender(replayId: string, strokes: any[], durationMs: number) {
    const queued = await this.jobs.queueReplay(replayId);
    if (!this.shuttingDown && queued.status === 'queued' && this.activeJobs.size < this.MAX_CONCURRENT) {
      const claimed = await this.jobs.claim(queued.jobId);
      if (claimed && claimed.replayId === replayId) this.startJob(claimed);
    }
    return queued;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processPendingReplays() {
    if (this.shuttingDown) return;
    await this.jobs.recoverStale();

    for (let slot = this.activeJobs.size; slot < this.MAX_CONCURRENT; slot++) {
      const claimed = await this.jobs.claimNextJob();
      if (!claimed) break;
      this.startJob(claimed);
    }
  }

  /**
   * Backfill replays created before render jobs were introduced (or whose job
   * row was lost). Only rows with no GIF and no job are eligible, and the batch
   * is capped so a large backlog cannot monopolise a cron tick.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileMissingRenderJobs() {
    if (this.shuttingDown || !this.prisma.hasOptionalTable('renderJob')) return 0;

    let pending: { id: string }[] = [];
    try {
      pending = await this.prisma.replay.findMany({
        where: { gifUrl: null, renderJob: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: RECONCILE_BATCH_SIZE,
      });
    } catch (err) {
      this.logger.error(
        'Could not reconcile missing render jobs',
        err instanceof Error ? err.message : String(err),
      );
      return 0;
    }

    for (const replay of pending) {
      try {
        await this.jobs.queueReplay(replay.id);
      } catch (err) {
        // A concurrent worker may have created/claimed the job between the
        // query and this call; that is not a reconciliation failure.
        this.logger.warn(
          `Could not queue missing render job for replay ${replay.id}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return pending.length;
  }

  /** Compensating cleanup for workers still in memory after a long outage. */
  async recoverStaleJobs() {
    await this.jobs.recoverStale();
  }

  /** Stop native threads and release their leases instead of waiting for expiry. */
  async onModuleDestroy() {
    this.shuttingDown = true;
    const pendingJobs = [...this.activeJobs.entries()];
    const runningWorkers = [...this.activeWorkers.entries()];

    await Promise.all(
      runningWorkers.map(async ([jobId, worker]) => {
        try {
          await worker.terminate();
        } catch (err) {
          this.logger.warn(
            `Could not terminate worker for render job ${jobId}`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }),
    );

    // fail() is state-guarded, so a job that completed during terminate() is
    // left alone while a running one is requeued/failed immediately.
    await Promise.all(
      pendingJobs.map(async ([jobId]) => {
        try {
          await this.jobs.fail(jobId, SHUTDOWN_ERROR);
        } catch (err) {
          this.logger.error(
            `Could not cancel render job ${jobId} on shutdown`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }),
    );

    await Promise.allSettled(pendingJobs.map(([, task]) => task));
  }

  private startJob(job: RenderJobRecord) {
    if (this.shuttingDown) {
      void this.jobs.fail(job.id, SHUTDOWN_ERROR).catch(err => {
        this.logger.error(
          `Could not cancel render job ${job.id} on shutdown`,
          err instanceof Error ? err.message : String(err),
        );
      });
      return;
    }

    const task = this.executeJob(job)
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.shuttingDown || message !== SHUTDOWN_ERROR) {
          this.logger.error(
            `Render job ${job.id} failed`,
            message,
          );
        }
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
    if (this.shuttingDown) {
      await this.jobs.fail(job.id, SHUTDOWN_ERROR);
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
      if (this.shuttingDown) {
        reject(new Error(SHUTDOWN_ERROR));
        return;
      }
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
      this.activeWorkers.set(jobId, worker);
      const releaseWorker = () => {
        if (this.activeWorkers.get(jobId) === worker) this.activeWorkers.delete(jobId);
      };

      const timeout = setTimeout(() => {
        releaseWorker();
        void worker.terminate();
        reject(new Error(this.shuttingDown ? SHUTDOWN_ERROR : `Worker timeout for ${jobId}`));
      }, RENDER_TIMEOUT_MS);

      worker.on('message', async (result: Buffer | { error: string }) => {
        clearTimeout(timeout);
        if (this.shuttingDown) {
          releaseWorker();
          reject(new Error(SHUTDOWN_ERROR));
          return;
        }
        if (result && typeof result === 'object' && 'error' in result) {
          releaseWorker();
          reject(new Error((result as { error: string }).error));
          return;
        }

        try {
          const gifBuffer = result as Buffer;
          await mkdir(this.renderDir, { recursive: true });

          const filename = `${replayId}.gif`;
          const filepath = join(this.renderDir, filename);
          await writeFile(filepath, gifBuffer);

          const gifUrl = `${REPLAY_URL_PREFIX}${filename}`;
          await this.prisma.replay.update({
            where: { id: replayId },
            data: { gifUrl },
          });

          this.logger.log(`Rendered replay ${jobId} -> ${gifUrl} (${gifBuffer.length} bytes)`);
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          releaseWorker();
        }
      });

      worker.on('error', err => {
        clearTimeout(timeout);
        releaseWorker();
        reject(err);
      });
      worker.on('exit', code => {
        clearTimeout(timeout);
        releaseWorker();
        if (code !== 0) {
          reject(new Error(this.shuttingDown ? SHUTDOWN_ERROR : `Worker exited with code ${code}`));
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
      const filepath = this.gifPathFor(replay.gifUrl);
      if (!filepath) {
        this.logger.warn(`Refusing to clean up unsafe gifUrl for replay ${replay.id}`);
        continue;
      }
      try {
        await unlink(filepath);
        deleted++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.logger.warn(
            `Could not unlink replay GIF for ${replay.id}`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      // The pointer is stale whether or not the file was still on disk.
      await this.prisma.replay.update({
        where: { id: replay.id },
        data: { gifUrl: null },
      });
    }

    this.logger.log(`Cleaned up ${deleted} old replay GIFs`);
    return { deleted };
  }

  /** Only accept locally generated /replays/<basename>.gif paths. */
  private gifPathFor(gifUrl: string | null): string | null {
    if (!gifUrl || !gifUrl.startsWith(REPLAY_URL_PREFIX)) return null;
    const filename = gifUrl.slice(REPLAY_URL_PREFIX.length);
    if (!filename || filename !== basename(filename)) return null;
    if (!/^[A-Za-z0-9_-]+\.gif$/.test(filename)) return null;
    return join(this.renderDir, filename);
  }
}
