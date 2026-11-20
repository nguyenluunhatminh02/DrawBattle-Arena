import { ReplayWorker } from './replay.worker';
import { RenderJobRecord } from './replay-jobs';

// @nestjs/schedule v12 ships ESM-only decorators that Jest (CJS) cannot load;
// the cron registration itself is not what these tests exercise.
jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_MINUTE: '* * * * *' },
}));
jest.mock('worker_threads', () => ({ Worker: jest.fn() }));

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
  } as any;
  return { worker: new ReplayWorker(prisma, jobs), prisma, jobs };
}

describe('ReplayWorker', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reconciles capped replays that have neither a GIF nor a job', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `replay-${i}` }));
    const { worker, prisma, jobs } = makeWorker(rows);

    const reconciled = await worker.reconcileMissingRenderJobs();

    expect(reconciled).toBe(100);
    expect(prisma.replay.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { gifUrl: null, renderJob: null },
        take: 100,
      }),
    );
    expect(jobs.queueReplay).toHaveBeenCalledTimes(100);
    expect(jobs.queueReplay).toHaveBeenCalledWith('replay-0');
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

  it('clears gifUrl after unlinking and refuses unsafe paths', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = jest.requireActual('fs/promises');
    const os = jest.requireActual('os');
    const path = jest.requireActual('path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'replay-cleanup-'));
    await mkdir(path.join(dir, 'public', 'replays'), { recursive: true });
    await writeFile(path.join(dir, 'public', 'replays', 'replay-1.gif'), 'gif');
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(dir);

    try {
      const { worker, prisma } = makeWorker([
        { id: 'replay-1', gifUrl: '/replays/replay-1.gif' },
        { id: 'replay-missing', gifUrl: '/replays/missing.gif' },
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
