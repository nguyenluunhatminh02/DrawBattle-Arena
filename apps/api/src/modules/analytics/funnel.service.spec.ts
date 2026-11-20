import { FunnelService } from './funnel.service';

describe('FunnelService', () => {
  const makePrisma = (overrides: Record<string, any> = {}) => ({
    hasOptionalTable: jest.fn().mockReturnValue(true),
    funnelEvent: {
      findFirst: jest.fn().mockResolvedValue({ id: 'probe' }),
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  });

  const settled = () => new Promise<void>(resolve => setImmediate(resolve));

  afterEach(() => jest.useRealTimers());

  it('normalises non-string session ids without throwing', async () => {
    const prisma = makePrisma();
    prisma.funnelEvent.findMany.mockResolvedValue([]);
    const service = new FunnelService(prisma as any);
    await settled();

    await expect(service.track('landing_view', 42 as any)).resolves.toMatchObject({
      ok: true,
    });
    await expect(service.track('landing_view', null as any)).resolves.toMatchObject({
      ok: true,
    });

    const result = await service.summary();
    expect(result.totalEvents).toBe(2);
    expect(result.counts.landing_view).toBe(2);
    expect(result.uniqueSessions).toBe(1);
    await service.onModuleDestroy();
  });

  it('falls back to memory when the capability check cannot query the table', async () => {
    const prisma = makePrisma({
      findFirst: jest.fn().mockRejectedValue(new Error('relation does not exist')),
    });
    const service = new FunnelService(prisma as any);
    await settled();

    expect(service.isDurable).toBe(false);
    expect(await service.track('landing_view', 's1')).toEqual({ ok: true, durable: false });
    expect(prisma.funnelEvent.createMany).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('flushes every pending batch and waits for an active flush on destroy', async () => {
    let releaseFirst: () => void = () => undefined;
    const firstWrite = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const createMany = jest
      .fn()
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValue(undefined);
    const prisma = makePrisma({ createMany });
    const service = new FunnelService(prisma as any);
    await settled();

    // Enqueue without awaiting the first flush so an in-flight write is active.
    for (let i = 0; i < 150; i++) {
      void service.track('landing_view', `session-${i}`);
    }
    await settled();
    expect(createMany).toHaveBeenCalledTimes(1);

    const destroy = service.onModuleDestroy();
    let destroyed = false;
    void destroy.then(() => {
      destroyed = true;
    });
    await settled();
    expect(destroyed).toBe(false);

    releaseFirst();
    await destroy;
    expect(createMany.mock.calls.map(call => call[0].data.length)).toEqual([100, 50]);
  });

  it('includes buffered and pending events in a durable summary', async () => {
    const prisma = makePrisma({
      findMany: jest.fn().mockResolvedValue([{ event: 'room_created', sessionId: 'db' }]),
    });
    const service = new FunnelService(prisma as any);
    await settled();

    await service.track('landing_view', 'buffered');
    await service.track('share_clicked', 'queued');

    const summary = await service.summary();
    expect(summary).toMatchObject({
      durable: true,
      totalEvents: 3,
      uniqueSessions: 3,
      counts: { room_created: 1, landing_view: 1, share_clicked: 1 },
    });
    await service.onModuleDestroy();
  });
});
