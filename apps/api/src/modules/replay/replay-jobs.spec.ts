import {
  CLAIM_CANDIDATE_LIMIT,
  failureTransition,
  InMemoryJobStore,
  isLeaseExpired,
  MAX_RENDER_ATTEMPTS,
  PrismaJobStore,
  RUNNING_LEASE_MS,
  type RawRenderJob,
  type RenderJobRecord,
} from './replay-jobs';

const now = new Date('2026-11-20T12:00:00.000Z');

describe('render job state machine', () => {
  const job = (overrides: Partial<RenderJobRecord> = {}): RenderJobRecord => ({
    id: 'job-1',
    replayId: 'replay-1',
    state: 'queued',
    attempts: 0,
    maxAttempts: MAX_RENDER_ATTEMPTS,
    error: null,
    lockedBy: null,
    lockedAt: null,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  it('requeues a failure with exponential backoff and clears the lease', () => {
    const first = failureTransition(job({ attempts: 0 }), 'worker crashed', now);
    expect(first).toMatchObject({
      state: 'queued',
      attempts: 1,
      error: 'worker crashed',
      lockedBy: null,
      lockedAt: null,
    });
    expect(first.nextAttemptAt.getTime() - now.getTime()).toBe(30_000);

    const second = failureTransition(job({ attempts: 1 }), 'timeout', now);
    expect(second.state).toBe('queued');
    expect(second.nextAttemptAt.getTime() - now.getTime()).toBe(2 * 60_000);

    const third = failureTransition(job({ attempts: 2, maxAttempts: 4 }), 'timeout', now);
    expect(third.nextAttemptAt.getTime() - now.getTime()).toBe(10 * 60_000);
  });

  it('marks a job failed after exhausting the retry budget', () => {
    const result = failureTransition(job({ attempts: MAX_RENDER_ATTEMPTS - 1 }), 'bad strokes', now);
    expect(result).toMatchObject({
      state: 'failed',
      attempts: MAX_RENDER_ATTEMPTS,
      error: 'bad strokes',
      nextAttemptAt: now,
    });
  });

  it('does not grant an exhausted job a fresh attempt budget (P2-03)', async () => {
    const store = new InMemoryJobStore();
    const created = await store.create('replay-1', now);
    for (let attempt = 0; attempt < MAX_RENDER_ATTEMPTS; attempt++) {
      const attemptTime = new Date(now.getTime() + attempt * 30 * 60_000);
      await store.markRunning(created.id, 'worker-a', attemptTime);
      await store.fail(created.id, 'worker-a', `failure ${attempt}`, attemptTime);
    }
    const exhausted = await store.findById(created.id);
    expect(exhausted).toMatchObject({ state: 'failed', attempts: MAX_RENDER_ATTEMPTS });

    // A retry must not requeue the exhausted job or reset its attempts.
    expect(await store.retryNow(created.id, now)).toBeNull();
    expect(await store.findById(created.id)).toMatchObject({
      state: 'failed',
      attempts: MAX_RENDER_ATTEMPTS,
    });
  });

  it('only treats running jobs past their lease as expired', () => {
    expect(isLeaseExpired(job({ state: 'running', lockedAt: now }), now)).toBe(false);
    expect(
      isLeaseExpired(
        job({ state: 'running', lockedAt: new Date(now.getTime() - RUNNING_LEASE_MS) }),
        now,
      ),
    ).toBe(true);
    expect(isLeaseExpired(job({ state: 'queued', lockedAt: null }), now)).toBe(false);
  });

  it('allows exactly one worker to claim a queued job', async () => {
    const store = new InMemoryJobStore();
    await store.create('replay-1', now);
    const first = await store.claimNext('worker-a', now);
    const second = await store.claimNext('worker-b', now);
    expect(first?.state).toBe('running');
    expect(first?.lockedBy).toBe('worker-a');
    expect(second).toBeNull();
  });

  it('respects backoff: a failed retry is not claimable before nextAttemptAt', async () => {
    const store = new InMemoryJobStore();
    const created = await store.create('replay-1', now);
    const claimed = await store.markRunning(created.id, 'worker-a', now);
    const failed = await store.fail(created.id, 'worker-a', 'oops', now);
    expect(failed?.state).toBe('queued');
    expect(failed?.attempts).toBe(claimed?.attempts! + 1);

    expect(await store.claimNext('worker-b', new Date(now.getTime() + 29_000))).toBeNull();
    const retry = await store.claimNext('worker-b', new Date(now.getTime() + 30_000));
    expect(retry?.id).toBe(created.id);
    expect(retry?.lockedBy).toBe('worker-b');
  });

  it('recovers an abandoned lease and moves it back to queued', async () => {
    const store = new InMemoryJobStore();
    const created = await store.create('replay-1', now);
    await store.markRunning(created.id, 'crashed-worker', now);
    expect(await store.pendingCount()).toBe(1);

    const later = new Date(now.getTime() + RUNNING_LEASE_MS + 1);
    expect(await store.recoverStale(later)).toBe(1);
    const recovered = await store.findById(created.id);
    expect(recovered).toMatchObject({ state: 'queued', lockedBy: null, lockedAt: null });
    expect((await store.claimNext('healthy-worker', later))?.id).toBe(created.id);
  });

  it('ignores success from a stale worker after a lease was reclaimed', async () => {
    const store = new InMemoryJobStore();
    const created = await store.create('replay-1', now);
    await store.markRunning(created.id, 'worker-a', now);
    const later = new Date(now.getTime() + RUNNING_LEASE_MS + 1);
    await store.recoverStale(later);
    await store.markRunning(created.id, 'worker-b', later);

    expect(await store.succeed(created.id, 'worker-b', later)).toMatchObject({ state: 'completed' });
    expect(await store.fail(created.id, 'worker-b', 'late failure', later)).toBeNull();
  });

  it('rejects results from a stale worker after another worker takes the lease', async () => {
    const store = new InMemoryJobStore();
    const created = await store.create('replay-1', now);
    await store.markRunning(created.id, 'worker-a', now);
    const later = new Date(now.getTime() + RUNNING_LEASE_MS + 1);
    await store.recoverStale(later);
    await store.markRunning(created.id, 'worker-b', later);

    expect(await store.succeed(created.id, 'worker-a', later)).toBeNull();
    expect(await store.fail(created.id, 'worker-a', 'late failure', later)).toBeNull();
    expect(await store.findById(created.id)).toMatchObject({ state: 'running', lockedBy: 'worker-b' });
    expect(await store.succeed(created.id, 'worker-b', later)).toMatchObject({ state: 'completed' });
  });
});

type PrismaWhere = Record<string, any>;

function matches(row: RawRenderJob, where: PrismaWhere): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = (row as unknown as PrismaWhere)[key];
    if (Array.isArray(expected)) return expected.some((item: PrismaWhere) => matches(row, item));
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
    if (expected && typeof expected === 'object') {
      if ('not' in expected && expected.not === null && actual === null) return false;
      if ('lte' in expected && (!actual || actual.getTime() > expected.lte.getTime())) return false;
      return true;
    }
    return actual === expected;
  });
}

/** Minimal Prisma delegate that enforces WHERE guards for the CAS paths under test. */
function fakePrisma(rows: RawRenderJob[], beforeFirstUpdate?: (rows: RawRenderJob[]) => void) {
  const byId = new Map(rows.map(row => [row.id, row]));
  let updates = 0;
  const delegate = {
    findMany: jest.fn(async ({ where, orderBy, take }: PrismaWhere) =>
      rows
        .filter(row => matches(row, where))
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
        .slice(0, take),
    ),
    findUnique: jest.fn(async ({ where }: PrismaWhere) => byId.get(where.id) ?? null),
    // Ambiguous by design: claimWhere must read by primary key instead.
    findFirst: jest.fn(() => {
      throw new Error('findFirst must not be used to read a claimed job');
    }),
    updateMany: jest.fn(async ({ where, data }: PrismaWhere) => {
      // Simulate a racing worker committing after this UPDATE's WHERE was
      // evaluated but before its write, which is what makes the CAS lose.
      const matched = rows.filter(row => matches(row, where));
      updates++;
      if (updates === 1) beforeFirstUpdate?.(rows);
      for (const row of matched) {
        // A real UPDATE rechecks its WHERE at write time: do not overwrite
        // another worker's freshly written lease.
        if (matches(row, where)) Object.assign(row, data);
      }
      return { count: matched.length };
    }),
  };
  return { prisma: { renderJob: delegate } as unknown as ConstructorParameters<typeof PrismaJobStore>[0], delegate };
}

function rawJob(overrides: Partial<RawRenderJob> = {}): RawRenderJob {
  return {
    id: 'job-1',
    replayId: 'replay-1',
    state: 'queued',
    attempts: 0,
    maxAttempts: MAX_RENDER_ATTEMPTS,
    error: null,
    lockedBy: null,
    lockedAt: null,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('PrismaJobStore', () => {
  it('reads the job updated by the guarded claim using its id', async () => {
    const target = rawJob({ id: 'job-target', replayId: 'replay-target' });
    const decoy = rawJob({
      id: 'job-decoy',
      replayId: 'replay-decoy',
      state: 'running',
      lockedBy: 'worker-a',
      lockedAt: now,
    });
    const { prisma, delegate } = fakePrisma([target, decoy]);
    const store = new PrismaJobStore(prisma);

    const claimed = await store.markRunning(target.id, 'worker-a', now);

    expect(claimed?.id).toBe(target.id);
    expect(delegate.findUnique).toHaveBeenCalledWith({ where: { id: target.id } });
    expect(decoy).toMatchObject({ lockedBy: 'worker-a' });
  });

  it('retries the next candidate after losing a CAS and still claims exactly one job', async () => {
    const stolen = rawJob({ id: 'job-1', replayId: 'replay-1' });
    const available = rawJob({ id: 'job-2', replayId: 'replay-2' });
    const { prisma, delegate } = fakePrisma([stolen, available], rows => {
      Object.assign(rows[0], {
        state: 'running',
        lockedBy: 'worker-b',
        lockedAt: now,
        updatedAt: now,
      });
    });
    const store = new PrismaJobStore(prisma);

    const claimed = await store.claimNext('worker-a', now);

    expect(claimed).toMatchObject({ id: available.id, state: 'running', lockedBy: 'worker-a' });
    expect(stolen).toMatchObject({ lockedBy: 'worker-b' });
    expect(delegate.updateMany).toHaveBeenCalledTimes(2);
    expect([stolen, available].filter(row => row.lockedBy === 'worker-a')).toHaveLength(1);
  });

  it('stops after five lost CAS attempts without claiming a job', async () => {
    const rows = Array.from({ length: CLAIM_CANDIDATE_LIMIT + 1 }, (_, index) =>
      rawJob({ id: `job-${index}`, replayId: `replay-${index}` }),
    );
    const { prisma, delegate } = fakePrisma(rows, all => {
      for (const row of all) {
        Object.assign(row, { state: 'running', lockedBy: 'worker-b', lockedAt: now, updatedAt: now });
      }
    });

    expect(await new PrismaJobStore(prisma).claimNext('worker-a', now)).toBeNull();
    expect(delegate.updateMany).toHaveBeenCalledTimes(CLAIM_CANDIDATE_LIMIT);
    expect(rows.filter(row => row.lockedBy === 'worker-a')).toHaveLength(0);
  });

  it('rejects success and failure from a stale lock holder', async () => {
    const row = rawJob({ state: 'running', lockedBy: 'worker-b', lockedAt: now });
    const { prisma } = fakePrisma([row]);
    const store = new PrismaJobStore(prisma);

    expect(await store.succeed(row.id, 'worker-a', now)).toBeNull();
    expect(await store.fail(row.id, 'worker-a', 'late failure', now)).toBeNull();
    expect(row).toMatchObject({ state: 'running', lockedBy: 'worker-b' });
    expect(await store.succeed(row.id, 'worker-b', new Date(now.getTime() + 1))).toMatchObject({
      state: 'completed',
    });
  });
});
