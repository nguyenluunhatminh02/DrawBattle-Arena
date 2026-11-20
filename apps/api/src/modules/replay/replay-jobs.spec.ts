import {
  failureTransition,
  InMemoryJobStore,
  isLeaseExpired,
  MAX_RENDER_ATTEMPTS,
  RUNNING_LEASE_MS,
  type RenderJobRecord,
} from './replay-jobs';

describe('render job state machine', () => {
  const now = new Date('2026-11-20T12:00:00.000Z');
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
    const failed = await store.fail(created.id, 'oops', now);
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

    expect(await store.succeed(created.id, later)).toMatchObject({ state: 'completed' });
    expect(await store.fail(created.id, 'late failure', later)).toBeNull();
  });
});
