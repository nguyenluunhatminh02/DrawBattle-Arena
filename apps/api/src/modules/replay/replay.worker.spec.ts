import { ReplayWorker } from './replay.worker';
import { RenderJobRecord } from './replay-jobs';

// @nestjs/schedule v12 ships ESM-only decorators that Jest (CJS) cannot load;
// the cron registration itself is not what these tests exercise.
// Jest hoists jest.mock factories above const declarations, so the recorder
// is initialised inside the factory rather than at module scope.
jest.mock('@nestjs/schedule', () => {
  const registrations: string[] = [];
  (globalThis as any).__cronRegistrations = registrations;
  return {
    Cron: (expression: string) => () => {
      registrations.push(expression);
      return undefined;
    },
    CronExpression: {
      EVERY_MINUTE: '* * * * *',
      EVERY_DAY_AT_3AM: '0 3 * * *',
    },
  };
});
jest.mock('worker_threads', () => ({
  Worker: jest.fn(),
  parentPort: null,
  workerData: undefined,
}));

const now = new Date('2026-11-20T12:00:00.000Z');
const job = (overrides: Partial<RenderJobRecord> = {}): RenderJobRecord => ({
  id: 'job-1',
  replayId: 'replay-1',
  state: 'running',
  attempts: 0,
  maxAttempts: 3,
  error: null,
  lockedBy: 'worker-test',
  lockedAt: now,
  nextAttemptAt: now,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

function makeWorker(replayRows: unknown[] = []) {
  const prisma = {
    hasOptionalTable: jest.fn().mockReturnValue(true),
    replay: {
      findMany: jest.fn().mockResolvedValue(replayRows),
      findUnique: jest.fn().mockResolvedValue({
        id: 'replay-1',
        strokes: [],
        durationMs: 1000,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
  const jobs = {
    queueReplay: jest.fn().mockResolvedValue({ jobId: 'job-1', status: 'queued' }),
    claim: jest.fn().mockResolvedValue(job({ state: 'running' })),
    claimNextJob: jest.fn().mockResolvedValue(null),
    fail: jest.fn().mockResolvedValue(null),
    succeed: jest.fn().mockResolvedValue(null),
    recoverStale: jest.fn().mockResolvedValue(undefined),
    retryMissingArtifact: jest.fn().mockResolvedValue(true),
  } as any;
  return { worker: new ReplayWorker(prisma, jobs), prisma, jobs };
}

describe('ReplayWorker', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reconciles capped replays that have neither a GIF nor a job', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `replay-${i}`, gifUrl: null }));
    const { worker, prisma, jobs } = makeWorker(rows);

    const reconciled = await worker.reconcileMissingRenderJobs();

    expect(reconciled).toBe(100);
    expect(prisma.replay.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { gifUrl: null, renderJob: null },
            { gifUrl: { startsWith: '/api/replays/file/' } },
          ]),
        }),
        take: 100,
        orderBy: { id: 'asc' },
      }),
    );
    expect(jobs.queueReplay).toHaveBeenCalledTimes(100);
    expect(jobs.queueReplay).toHaveBeenCalledWith('replay-0');
  });

  it('requeues completed jobs whose GIF artifact is missing, with a bounded budget', async () => {
    const { mkdtemp, mkdir, rm } = jest.requireActual('fs/promises');
    const os = jest.requireActual('os');
    const path = jest.requireActual('path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'replay-reconcile-'));
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      const { worker, jobs } = makeWorker([
        { id: 'replay-missing', gifUrl: '/api/replays/file/replay-missing.gif' },
      ]);
      await mkdir(path.join(dir, 'private-replays'), { recursive: true });

      expect(await worker.reconcileMissingRenderJobs()).toBe(1);
      expect(jobs.retryMissingArtifact).toHaveBeenCalledWith(
        'replay-missing',
        '/api/replays/file/replay-missing.gif',
      );
      expect(jobs.queueReplay).not.toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not requeue a pointer whose artifact exists', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = jest.requireActual('fs/promises');
    const os = jest.requireActual('os');
    const path = jest.requireActual('path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'replay-present-'));
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      await mkdir(path.join(dir, 'private-replays'), { recursive: true });
      await writeFile(path.join(dir, 'private-replays', 'replay-1.gif'), 'gif');
      const { worker, jobs } = makeWorker([
        { id: 'replay-1', gifUrl: '/api/replays/file/replay-1.gif' },
      ]);

      expect(await worker.reconcileMissingRenderJobs()).toBe(0);
      expect(jobs.retryMissingArtifact).not.toHaveBeenCalled();
      expect(jobs.queueReplay).not.toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips reconciliation when the job table is unavailable', async () => {
    const { worker, prisma, jobs } = makeWorker([{ id: 'replay-1' }]);
    prisma.hasOptionalTable.mockReturnValue(false);

    expect(await worker.reconcileMissingRenderJobs()).toBe(0);
    expect(prisma.replay.findMany).not.toHaveBeenCalled();
    expect(jobs.queueReplay).not.toHaveBeenCalled();
  });

  it('terminates active workers and fails their jobs on shutdown', async () => {
    const { worker, jobs } = makeWorker();
    const terminate = jest.fn().mockResolvedValue(undefined);
    const { Worker } = jest.requireMock('worker_threads');
    const listeners: Record<string, (...args: any[]) => void> = {};
    Worker.mockImplementation(() => ({
      on: (event: string, cb: (...args: any[]) => void) => {
        listeners[event] = cb;
        return undefined;
      },
      terminate,
    }));

    // Simulate an already-running render by registering a fake worker and task.
    const task = new Promise<void>(resolve => setTimeout(resolve, 1000));
    (worker as any).activeWorkers.set('job-1', { terminate });
    (worker as any).activeJobs.set('job-1', task);

    await worker.onModuleDestroy();

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(jobs.fail).toHaveBeenCalledWith('job-1', expect.stringContaining('shut down'));
    // A late message from the terminated worker must not complete the render.
    await expect(
      (worker as any).renderInWorker('job-1', 'replay-1', [], 1000),
    ).rejects.toThrow(/shut down/);
  });

  it('moves legacy public GIFs into the private directory and rewrites pointers', async () => {
    const { mkdtemp, mkdir, writeFile, readFile, rm } = jest.requireActual('fs/promises');
    const os = jest.requireActual('os');
    const path = jest.requireActual('path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'replay-migration-'));
    await mkdir(path.join(dir, 'public', 'replays'), { recursive: true });
    await writeFile(path.join(dir, 'public', 'replays', 'replay-1.gif'), 'gif');
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(dir);

    try {
      const { worker, prisma } = makeWorker([
        { id: 'replay-1', gifUrl: '/replays/replay-1.gif' },
        { id: 'replay-gone', gifUrl: '/replays/replay-gone.gif' },
      ]);
      const result = await worker.migrateLegacyPublicGifs();

      expect(result).toEqual({ migrated: 2, cleared: 1, removed: 1 });
      await expect(
        readFile(path.join(dir, 'private-replays', 'replay-1.gif'), 'utf8'),
      ).resolves.toBe('gif');
      expect(prisma.replay.update).toHaveBeenCalledWith({
        where: { id: 'replay-1' },
        data: { gifUrl: '/api/replays/file/replay-1.gif' },
      });
      expect(prisma.replay.update).toHaveBeenCalledWith({
        where: { id: 'replay-gone' },
        data: { gifUrl: null },
      });
    } finally {
      cwd.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('registers a daily cleanup cron in addition to the minute crons', () => {
    // Decorators execute at class definition time; the mock records them.
    const crons = jest.requireMock('@nestjs/schedule').CronExpression as Record<string, string>;
    expect(crons.EVERY_DAY_AT_3AM).toBe('0 3 * * *');
    expect((globalThis as any).__cronRegistrations).toContain('0 3 * * *');
  });

  it('caps scheduled cleanup batches and reuses the 30-day default', async () => {
    jest.useFakeTimers().setSystemTime(now);
    try {
      const { worker, prisma } = makeWorker();
      expect(await worker.scheduledCleanupOldReplays()).toEqual({ deleted: 0 });
      expect(prisma.replay.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdAt: { lt: new Date('2026-10-21T12:00:00.000Z') }, gifUrl: { not: null } },
          take: 100,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('swallows scheduled cleanup failures so the cron tick does not reject', async () => {
    const { worker, prisma } = makeWorker();
    prisma.replay.findMany.mockRejectedValueOnce(new Error('db down'));

    await expect(worker.scheduledCleanupOldReplays()).resolves.toEqual({ deleted: 0 });
  });

  it('clears gifUrl after unlinking and refuses unsafe paths', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = jest.requireActual('fs/promises');
    const os = jest.requireActual('os');
    const path = jest.requireActual('path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'replay-cleanup-'));
    await mkdir(path.join(dir, 'private-replays'), { recursive: true });
    await writeFile(path.join(dir, 'private-replays', 'replay-1.gif'), 'gif');
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(dir);

    try {
      const { worker, prisma } = makeWorker([
        { id: 'replay-1', gifUrl: '/api/replays/file/replay-1.gif' },
        { id: 'replay-missing', gifUrl: '/api/replays/file/replay-missing.gif' },
        { id: 'replay-unsafe', gifUrl: '/replays/../../etc/passwd' },
        { id: 'replay-external', gifUrl: 'https://example.com/replays/x.gif' },
      ]);
      const result = await worker.cleanupOldReplays();

      expect(result.deleted).toBe(1);
      expect(prisma.replay.update).toHaveBeenCalledTimes(2);
      expect(prisma.replay.update).toHaveBeenCalledWith({
        where: { id: 'replay-1' },
        data: { gifUrl: null },
      });
      expect(prisma.replay.update).toHaveBeenCalledWith({
        where: { id: 'replay-missing' },
        data: { gifUrl: null },
      });
      expect(prisma.replay.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'replay-unsafe' } }),
      );
    } finally {
      cwd.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
