import { ConflictException, GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { existsSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { replayFilenameFromPointer, replayRenderDir } from './replay-paths';

export const RENDER_STATES = ['queued', 'running', 'completed', 'failed'] as const;
export type RenderState = (typeof RENDER_STATES)[number];

/** A job whose deadline has passed is considered abandoned by its worker. */
export const RUNNING_LEASE_MS = 5 * 60 * 1000;
export const MAX_RENDER_ATTEMPTS = 3;

/** Number of queued/stale candidates examined per claim attempt. */
export const CLAIM_CANDIDATE_LIMIT = 5;

/** Retry backoff: 30s, 2m, 10m. The index is the number of completed attempts. */
const BACKOFF_SCHEDULE_MS = [30_000, 2 * 60_000, 10 * 60_000];

export interface RenderJobRecord {
  id: string;
  replayId: string;
  state: RenderState;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  lockedBy: string | null;
  lockedAt: Date | null;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RenderJobSnapshot {
  jobId: string;
  replayId: string;
  status: RenderState;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  error: string | null;
}

/** Input accepted by {@link canClaim}; SQL update semantics are applied locally. */
export interface ClaimCandidate {
  state: string;
  lockedBy: string | null;
  lockedAt: Date | null;
  nextAttemptAt: Date;
}

export function backoffDelayMs(attempts: number): number {
  return BACKOFF_SCHEDULE_MS[Math.min(Math.max(attempts, 0), BACKOFF_SCHEDULE_MS.length - 1)];
}

export function failureTransition(
  job: Pick<RenderJobRecord, 'attempts' | 'maxAttempts'>,
  error: string,
  now: Date = new Date(),
): Pick<RenderJobRecord, 'state' | 'attempts' | 'error' | 'nextAttemptAt' | 'lockedBy' | 'lockedAt'> {
  const attempts = job.attempts + 1;
  const exhausted = attempts >= job.maxAttempts;
  return {
    state: exhausted ? 'failed' : 'queued',
    attempts,
    error: String(error).slice(0, 2000),
    nextAttemptAt: exhausted ? now : new Date(now.getTime() + backoffDelayMs(attempts - 1)),
    lockedBy: null,
    lockedAt: null,
  };
}

export function isLeaseExpired(job: ClaimCandidate, now: Date): boolean {
  return (
    job.state === 'running' &&
    !!job.lockedAt &&
    now.getTime() - job.lockedAt.getTime() >= RUNNING_LEASE_MS
  );
}

/**
 * Single-writer claim test: only a queued job whose backoff has elapsed, or a
 * running job whose lease expired, may move to `running`. This is the in-memory
 * equivalent of the guarded UPDATE in PrismaJobStore.claimNext().
 */
export function canClaim(job: ClaimCandidate, now: Date): boolean {
  return (
    (job.state === 'queued' && job.nextAttemptAt.getTime() <= now.getTime()) ||
    isLeaseExpired(job, now)
  );
}

export function toSnapshot(job: RenderJobRecord): RenderJobSnapshot {
  return {
    jobId: job.id,
    replayId: job.replayId,
    status: job.state,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    nextAttemptAt: job.nextAttemptAt.toISOString(),
    error: job.error,
  };
}

interface JobStore {
  findByReplay(replayId: string): Promise<RenderJobRecord | null>;
  findById(jobId: string): Promise<RenderJobRecord | null>;
  create(replayId: string, now: Date): Promise<RenderJobRecord>;
  claimNext(holder: string, now: Date): Promise<RenderJobRecord | null>;
  markRunning(jobId: string, holder: string, now: Date): Promise<RenderJobRecord | null>;
  /** `holder` is the fencing token from the successful claim: only the current lock owner may finish it. */
  succeed(jobId: string, holder: string, now: Date): Promise<RenderJobRecord | null>;
  fail(jobId: string, holder: string, error: string, now: Date): Promise<RenderJobRecord | null>;
  /** Bounded requeue for a completed job whose GIF artifact was lost from disk. */
  retryMissingArtifact(jobId: string, now: Date): Promise<RenderJobRecord | null>;
  /** Requeue expired leases while consuming an attempt from the original budget. */
  recoverStale(now: Date): Promise<number>;
  pendingCount(): Promise<number>;
}

/**
 * Process-local job store. Used only when the `render_jobs` table is not
 * deployed yet, so a single API instance still has a real lifecycle. Multiple
 * API instances must deploy the schema described in notes for shared claiming.
 */
export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, RenderJobRecord>();
  private readonly byReplay = new Map<string, string>();

  async findByReplay(replayId: string) {
    const id = this.byReplay.get(replayId);
    return id ? this.jobs.get(id) ?? null : null;
  }

  async findById(jobId: string) {
    return this.jobs.get(jobId) ?? null;
  }

  async create(replayId: string, now: Date) {
    const existing = await this.findByReplay(replayId);
    if (existing) return existing;
    const job: RenderJobRecord = {
      id: `job_${replayId}`,
      replayId,
      state: 'queued',
      attempts: 0,
      maxAttempts: MAX_RENDER_ATTEMPTS,
      error: null,
      lockedBy: null,
      lockedAt: null,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.byReplay.set(replayId, job.id);
    return job;
  }

  async claimNext(holder: string, now: Date) {
    for (const job of this.jobs.values()) {
      if (!canClaim(job, now)) continue;
      const claimed: RenderJobRecord = {
        ...job,
        state: 'running',
        lockedBy: holder,
        lockedAt: now,
        updatedAt: now,
      };
      this.jobs.set(job.id, claimed);
      return claimed;
    }
    return null;
  }

  async markRunning(jobId: string, holder: string, now: Date) {
    const job = this.jobs.get(jobId);
    if (!job || !canClaim(job, now)) return null;
    const updated: RenderJobRecord = {
      ...job,
      state: 'running',
      lockedBy: holder,
      lockedAt: now,
      updatedAt: now,
    };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async succeed(jobId: string, holder: string, now: Date) {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== 'running' || job.lockedBy !== holder) return null;
    const updated: RenderJobRecord = {
      ...job,
      state: 'completed',
      error: null,
      lockedBy: null,
      lockedAt: null,
      nextAttemptAt: now,
      updatedAt: now,
    };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async fail(jobId: string, holder: string, error: string, now: Date) {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== 'running' || job.lockedBy !== holder) return null;
    const updated: RenderJobRecord = { ...job, ...failureTransition(job, error, now), updatedAt: now };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async retryMissingArtifact(jobId: string, now: Date) {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== 'completed' || job.attempts >= job.maxAttempts) return null;
    const updated: RenderJobRecord = {
      ...job,
      state: 'queued',
      // A rebuild consumes one attempt from the ORIGINAL budget; no reset.
      attempts: job.attempts + 1,
      error: 'Rendered GIF artifact missing; rebuilding',
      nextAttemptAt: now,
      lockedBy: null,
      lockedAt: null,
      updatedAt: now,
    };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async pendingCount() {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.state === 'queued' || job.state === 'running') count++;
    }
    return count;
  }

  /** Requeue running jobs whose worker lease expired, consuming one attempt. */
  async recoverStale(now: Date = new Date()) {
    const cutoff = new Date(now.getTime() - RUNNING_LEASE_MS);
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (!isLeaseExpired(job, now) || !job.lockedAt || job.lockedAt > cutoff) continue;
      const transition = failureTransition(job, 'Worker lease expired', now);
      this.jobs.set(job.id, { ...job, ...transition, updatedAt: now });
      recovered++;
    }
    return recovered;
  }
}

/** Rows as returned by Prisma when the schema extension is deployed. */
export interface RawRenderJob {
  id: string;
  replayId: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  lockedBy: string | null;
  lockedAt: Date | null;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

function normalize(row: RawRenderJob): RenderJobRecord {
  return { ...row, state: row.state as RenderState };
}

/** Durable job store using the optional `render_jobs` table (no migration here). */
export class PrismaJobStore implements JobStore {
  constructor(private readonly prisma: PrismaService) {}

  async findByReplay(replayId: string) {
    const row = await this.prisma.renderJob.findUnique({ where: { replayId } });
    return row ? normalize(row) : null;
  }

  async findById(jobId: string) {
    const row = await this.prisma.renderJob.findUnique({ where: { id: jobId } });
    return row ? normalize(row) : null;
  }

  async create(replayId: string, now: Date) {
    const row = await this.prisma.renderJob.upsert({
      where: { replayId },
      create: { replayId, state: 'queued', maxAttempts: MAX_RENDER_ATTEMPTS, nextAttemptAt: now },
      update: {},
    });
    return normalize(row);
  }

  /**
   * Atomic compare-and-set. The WHERE clause makes two workers racing for the
   * same job impossible: at most one UPDATE matches, regardless of process.
   */
  private async claimWhere(
    where: Record<string, unknown> & { id: string },
    holder: string,
    now: Date,
  ) {
    const claimed = await this.prisma.renderJob.updateMany({
      where: where as never,
      data: { state: 'running', lockedBy: holder, lockedAt: now, updatedAt: now },
    });
    if (claimed.count === 0) return null;
    // Read by primary key. A findFirst on lease fields could return a different
    // job when two claims share the same holder and millisecond timestamp.
    const row = await this.prisma.renderJob.findUnique({ where: { id: where.id } });
    return row ? normalize(row) : null;
  }

  async claimNext(holder: string, now: Date) {
    const staleCutoff = new Date(now.getTime() - RUNNING_LEASE_MS);
    const where = {
      OR: [
        { state: 'queued' as const, nextAttemptAt: { lte: now } },
        { state: 'running' as const, lockedAt: { not: null, lte: staleCutoff } },
      ],
    };
    // Read several candidates: another worker may win the CAS on the first one,
    // in which case we still try the next queued/stale job. Each guarded UPDATE
    // matches at most one row, so a worker still claims exactly one job.
    const candidates = await this.prisma.renderJob.findMany({
      where,
      orderBy: { nextAttemptAt: 'asc' },
      take: CLAIM_CANDIDATE_LIMIT,
    });

    for (const candidate of candidates) {
      const claimed = await this.prisma.renderJob.updateMany({
        where: { id: candidate.id, ...where },
        data: { state: 'running', lockedBy: holder, lockedAt: now, updatedAt: now },
      });
      if (claimed.count === 0) continue;
      const row = await this.prisma.renderJob.findUnique({ where: { id: candidate.id } });
      if (row && row.lockedBy === holder) return normalize(row);
    }
    return null;
  }

  async markRunning(jobId: string, holder: string, now: Date) {
    const staleCutoff = new Date(now.getTime() - RUNNING_LEASE_MS);
    return this.claimWhere(
      {
        id: jobId,
        OR: [
          { state: 'queued', nextAttemptAt: { lte: now } },
          { state: 'running', lockedAt: { not: null, lte: staleCutoff } },
        ],
      },
      holder,
      now,
    );
  }

  async succeed(jobId: string, holder: string, now: Date) {
    const updated = await this.prisma.renderJob.updateMany({
      where: { id: jobId, state: 'running', lockedBy: holder },
      data: {
        state: 'completed',
        error: null,
        lockedBy: null,
        lockedAt: null,
        nextAttemptAt: now,
        updatedAt: now,
      },
    });
    return updated.count > 0 ? this.findById(jobId) : null;
  }

  async fail(jobId: string, holder: string, error: string, now: Date) {
    const job = await this.findById(jobId);
    if (!job || job.state !== 'running' || job.lockedBy !== holder) return null;
    const transition = failureTransition(job, error, now);
    const updated = await this.prisma.renderJob.updateMany({
      where: { id: jobId, state: 'running', lockedBy: holder },
      data: { ...transition, updatedAt: now },
    });
    return updated.count > 0 ? this.findById(jobId) : null;
  }

  async retryMissingArtifact(jobId: string, now: Date) {
    // Atomic compare-and-set: only a completed job with budget left can be
    // rebuilt. Concurrent reconciliation calls cannot both requeue the same
    // job, and attempts are never reset.
    const updated = await this.prisma.renderJob.updateMany({
      where: { id: jobId, state: 'completed', attempts: { lt: MAX_RENDER_ATTEMPTS } },
      data: {
        state: 'queued',
        attempts: { increment: 1 },
        error: 'Rendered GIF artifact missing; rebuilding',
        nextAttemptAt: now,
        lockedBy: null,
        lockedAt: null,
        updatedAt: now,
      },
    });
    return updated.count > 0 ? this.findById(jobId) : null;
  }

  async recoverStale(now: Date = new Date()) {
    const staleCutoff = new Date(now.getTime() - RUNNING_LEASE_MS);
    const stale = await this.prisma.renderJob.findMany({
      where: { state: 'running', lockedAt: { not: null, lte: staleCutoff } },
      select: { id: true, attempts: true, maxAttempts: true },
    });
    let recovered = 0;
    for (const job of stale) {
      const transition = failureTransition(
        { attempts: job.attempts, maxAttempts: job.maxAttempts },
        'Worker lease expired',
        now,
      );
      // A single guarded UPDATE per job: the previous owner's late succeed()
      // cannot win after this fence, and an exhausted lease ends terminal.
      const result = await this.prisma.renderJob.updateMany({
        where: { id: job.id, state: 'running', lockedAt: { not: null, lte: staleCutoff } },
        data: { ...transition, updatedAt: now },
      });
      recovered += result.count;
    }
    return recovered;
  }

  async pendingCount() {
    return this.prisma.renderJob.count({
      where: { state: { in: ['queued', 'running'] } },
    });
  }
}

export interface QueueResult {
  jobId: string;
  status: RenderState | 'already_rendered';
}

/**
 * Owns the replay -> render-job lifecycle. The store is chosen once at startup
 * based on whether the deployed database has the optional job table.
 */
@Injectable()
export class ReplayJobService {
  private readonly logger = new Logger(ReplayJobService.name);
  private readonly store: JobStore;
  private readonly holder = `worker-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  constructor(private readonly prisma: PrismaService) {
    if (this.prisma.hasOptionalTable('renderJob')) {
      this.store = new PrismaJobStore(this.prisma);
    } else {
      this.store = new InMemoryJobStore();
      this.logger.warn('render_jobs table unavailable; using process-local render jobs');
    }
  }

  get usesDurableStore(): boolean {
    return this.store instanceof PrismaJobStore;
  }

  async queueReplay(replayId: string): Promise<QueueResult> {
    const replay = await this.prisma.replay.findUnique({ where: { id: replayId } });
    if (!replay) throw new NotFoundException('Replay not found');
    if (replay.gifUrl) return { jobId: replayId, status: 'already_rendered' };

    const now = new Date();
    let job = await this.store.findByReplay(replayId);
    if (!job) job = await this.store.create(replayId, now);
    if (job.state === 'completed') return { jobId: job.id, status: 'completed' };
    if (job.state === 'failed') {
      // A failed job is terminal. Its budget is exhausted by definition (see
      // failureTransition); the only bounded repair path is a missing artifact
      // on a completed job, handled by the reconciliation worker.
      return { jobId: job.id, status: 'failed' };
    }
    if (job.state === 'running' && !isLeaseExpired(job, now)) {
      throw new ConflictException({
        message: 'A render is already running for this replay',
        job: toSnapshot(job),
      });
    }
    // Queueing must leave the job claimable. The worker owns the transition to
    // running; otherwise a job could sit in `running` with no worker executing
    // it until the lease expires.
    return { jobId: job.id, status: 'queued' };
  }

  /** Atomically claims the next claimable job for this worker instance. */
  async claimNextJob(now: Date = new Date()): Promise<RenderJobRecord | null> {
    return this.store.claimNext(this.holder, now);
  }

  /** Called by the worker immediately before it starts the native render. */
  async claim(jobId: string, now: Date = new Date()) {
    const job = await this.store.markRunning(jobId, this.holder, now);
    if (!job) throw new ConflictException('Render job is not claimable');
    return job;
  }

  async succeed(jobId: string) {
    return this.store.succeed(jobId, this.holder, new Date());
  }

  async fail(jobId: string, error: string) {
    const job = await this.store.fail(jobId, this.holder, error, new Date());
    if (job?.state === 'failed') {
      this.logger.error(`Render job ${jobId} exhausted ${job.attempts} attempts: ${error}`);
    }
    return job;
  }

  async getStatus(jobId: string) {
    const job = await this.store.findById(jobId);
    if (!job) throw new NotFoundException('Render job not found');
    const replay = await this.prisma.replay.findUnique({ where: { id: job.replayId } });
    if (!replay) throw new NotFoundException('Replay not found');
    return { ...toSnapshot(job), gifUrl: replay.gifUrl, available: !!replay.gifUrl };
  }

  async getStatusByReplay(replayId: string) {
    const replay = await this.prisma.replay.findUnique({ where: { id: replayId } });
    if (!replay) throw new NotFoundException('Replay not found');
    const job = await this.store.findByReplay(replayId);
    const base = {
      jobId: job?.id ?? null,
      replayId,
      status: replay.gifUrl ? 'completed' : (job?.state ?? 'queued'),
      attempts: job?.attempts ?? 0,
      maxAttempts: job?.maxAttempts ?? MAX_RENDER_ATTEMPTS,
      nextAttemptAt: job?.nextAttemptAt.toISOString() ?? new Date().toISOString(),
      error: job?.error ?? null,
      gifUrl: replay.gifUrl,
      available: !!replay.gifUrl,
    };
    if (!replay.gifUrl && job?.state === 'failed') {
      return { ...base, detail: 'Render failed permanently' };
    }
    if (!replay.gifUrl && job?.state === 'running' && job.lockedAt) {
      const leaseEndsAt = new Date(job.lockedAt.getTime() + RUNNING_LEASE_MS).toISOString();
      return { ...base, detail: `Render is running; next status check after ${leaseEndsAt}` };
    }
    return base;
  }

  /**
   * Requeue a COMPLETED job whose GIF artifact was lost. The retry consumes an
   * attempt from the original budget; exhausted jobs stay terminal so the
   * minute cron can never enter an infinite rebuild loop.
   */
  async retryMissingArtifact(replayId: string, gifUrl: string): Promise<boolean> {
    const job = await this.store.findByReplay(replayId);
    if (!job || job.state !== 'completed' || job.attempts >= job.maxAttempts) return false;
    const retried = await this.store.retryMissingArtifact(job.id, new Date());
    if (!retried) return false;
    // Clear the dangling pointer only if it has not been replaced by a
    // concurrent render. updateMany avoids a P2025 race and keeps outcomes
    // consistent: a fresh pointer from another worker is left untouched.
    await this.prisma.replay.updateMany({
      where: { id: replayId, gifUrl },
      data: { gifUrl: null },
    });
    return true;
  }

  /** Ejects jobs stuck in a running state after a crashed worker. */
  async recoverStale(now: Date = new Date()) {
    await this.store.recoverStale(now);
  }

  async pendingCount() {
    return this.store.pendingCount();
  }

  async getJobByReplay(replayId: string) {
    return this.store.findByReplay(replayId);
  }

  /**
   * GoneException distinguishes "not rendered yet" from a missing replay.
   * A non-null pointer is not enough: the artifact must exist on disk or the
   * caller would follow a dangling URL. Missing artifacts are requeued by the
   * reconciliation worker within the job's remaining attempt budget.
   */
  assertRendered(
    replay: { id?: string; gifUrl: string | null },
    job: RenderJobRecord | null,
  ) {
    if (replay.gifUrl) {
      const filename = replay.id
        ? replayFilenameFromPointer(replay.gifUrl, replay.id)
        : null;
      if (filename && existsSync(join(replayRenderDir(), filename))) return replay.gifUrl;
      throw new GoneException('Rendered GIF artifact is unavailable');
    }
    if (job?.state === 'failed') throw new GoneException('Render failed permanently');
    throw new GoneException({
      message: 'GIF not yet rendered',
      status: job?.state ?? 'queued',
      nextAttemptAt: job?.nextAttemptAt.toISOString() ?? null,
    });
  }
}
