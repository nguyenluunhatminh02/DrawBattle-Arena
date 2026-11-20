import { CleanupService } from './cleanup.service';

describe('CleanupService retention', () => {
  const makePrisma = (rooms: unknown[], guests: unknown[], roomDeleteCount = 0, guestDeleteCount = 0) => {
    const roomFindMany = jest.fn().mockResolvedValue(rooms);
    const guestFindMany = jest.fn().mockResolvedValue(guests);
    const roomDeleteMany = jest.fn().mockResolvedValue({ count: roomDeleteCount });
    const guestDeleteMany = jest.fn().mockResolvedValue({ count: guestDeleteCount });
    const funnelFindMany = jest.fn().mockResolvedValue([]);
    const funnelDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const renderFindMany = jest.fn().mockResolvedValue([]);
    const renderDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      hasOptionalTable: jest.fn().mockReturnValue(true),
      room: { findMany: roomFindMany, deleteMany: roomDeleteMany },
      guestSession: { findMany: guestFindMany, deleteMany: guestDeleteMany },
      challenge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      funnelEvent: { findMany: funnelFindMany, deleteMany: funnelDeleteMany },
      renderJob: { findMany: renderFindMany, deleteMany: renderDeleteMany },
    } as any;
    return {
      service: new CleanupService(prisma),
      prisma,
      roomFindMany,
      guestFindMany,
      roomDeleteMany,
      guestDeleteMany,
      funnelFindMany,
      funnelDeleteMany,
      renderFindMany,
      renderDeleteMany,
    };
  };

  it('caps each cleanup pass and rechecks the predicate on delete', async () => {
    const rooms = Array.from({ length: 500 }, (_, i) => ({ id: `room-${i}` }));
    const guests = Array.from({ length: 500 }, (_, i) => ({ id: `guest-${i}` }));
    const { service, roomDeleteMany, guestDeleteMany } = makePrisma(rooms, guests, 500, 480);

    await service.run();

    expect(roomDeleteMany.mock.calls[0][0].where.id.in).toHaveLength(500);
    expect(roomDeleteMany.mock.calls[0][0].where.matches).toEqual({ none: {} });
    expect(guestDeleteMany.mock.calls[0][0].where).toMatchObject({
      expiresAt: { lt: expect.any(Date) },
      roomPlayers: { every: { leftAt: { not: null } } },
      dailyChallengeAttempts: { none: {} },
    });
  });

  it('skips deletes when there are no expired candidates', async () => {
    const { service, roomDeleteMany, guestDeleteMany } = makePrisma([], []);
    await service.run();
    expect(roomDeleteMany).not.toHaveBeenCalled();
    expect(guestDeleteMany).not.toHaveBeenCalled();
  });

  it('does not allow one failing table to abort the rest of cleanup', async () => {
    const { service } = makePrisma([], []);
    jest.spyOn(service as any, 'deleteExpiredRooms').mockRejectedValue(new Error('db down'));
    await expect(service.run()).resolves.toBeUndefined();
  });

  it('prunes old funnel events in bounded batches', async () => {
    const events = Array.from({ length: 500 }, (_, i) => ({ id: `event-${i}` }));
    const { service, prisma, funnelFindMany, funnelDeleteMany } = makePrisma([], []);
    funnelFindMany.mockResolvedValue(events);
    funnelDeleteMany.mockResolvedValue({ count: 500 });

    await service.run();

    expect(prisma.hasOptionalTable).toHaveBeenCalledWith('funnelEvent');
    expect(funnelFindMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expect.any(Date) } },
      select: { id: true },
      take: 500,
      orderBy: { createdAt: 'asc' },
    });
    expect(funnelDeleteMany.mock.calls[0][0].where.id.in).toHaveLength(500);
    expect(funnelDeleteMany.mock.calls[0][0].where.createdAt).toEqual({ lt: expect.any(Date) });
  });

  it('prunes only old failed render jobs in bounded batches', async () => {
    const jobs = Array.from({ length: 500 }, (_, i) => ({ id: `job-${i}` }));
    const { service, prisma, renderFindMany, renderDeleteMany } = makePrisma([], []);
    renderFindMany.mockResolvedValue(jobs);
    renderDeleteMany.mockResolvedValue({ count: 500 });

    await service.run();

    expect(prisma.hasOptionalTable).toHaveBeenCalledWith('renderJob');
    expect(renderFindMany).toHaveBeenCalledWith({
      where: { state: 'failed', updatedAt: { lt: expect.any(Date) } },
      select: { id: true },
      take: 500,
      orderBy: { updatedAt: 'asc' },
    });
    expect(renderDeleteMany.mock.calls[0][0].where).toMatchObject({
      id: { in: jobs.map(job => job.id) },
      state: 'failed',
      updatedAt: { lt: expect.any(Date) },
    });
  });

  it('skips optional-table cleanup when the tables are unavailable', async () => {
    const { service, prisma, funnelFindMany, renderFindMany } = makePrisma([], []);
    prisma.hasOptionalTable.mockReturnValue(false);

    await service.run();

    expect(funnelFindMany).not.toHaveBeenCalled();
    expect(renderFindMany).not.toHaveBeenCalled();
  });
});
