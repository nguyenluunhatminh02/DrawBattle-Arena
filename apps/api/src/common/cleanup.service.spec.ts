// Jest in this repo does not transform @nestjs/schedule's ESM build; the
// decorator is irrelevant to these service tests.
jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_HOUR: '0 * * * *' },
}));

import { CleanupService } from './cleanup.service';
import { LeaderboardService } from '../modules/leaderboard/leaderboard.service';

describe('CleanupService retention', () => {
  const makePrisma = (
    rooms: unknown[] = [],
    guests: unknown[] = [],
    roomDeleteCount = 0,
    guestDeleteCount = 0,
  ) => {
    const roomFindMany = jest.fn().mockResolvedValue(rooms);
    const guestFindMany = jest.fn().mockResolvedValue(guests);
    const roomDeleteMany = jest.fn().mockResolvedValue({ count: roomDeleteCount });
    const guestDeleteMany = jest.fn().mockResolvedValue({ count: guestDeleteCount });
    const challengeFindMany = jest.fn().mockResolvedValue([]);
    const challengeUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    const challengeDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const replayDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const funnelFindMany = jest.fn().mockResolvedValue([]);
    const funnelDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const renderFindMany = jest.fn().mockResolvedValue([]);
    const renderDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const matchFindFirst = jest.fn().mockResolvedValue(null);
    const prisma = {
      hasOptionalTable: jest.fn().mockReturnValue(true),
      room: { findMany: roomFindMany, deleteMany: roomDeleteMany },
      guestSession: { findMany: guestFindMany, deleteMany: guestDeleteMany },
      challenge: {
        findMany: challengeFindMany,
        updateMany: challengeUpdateMany,
        deleteMany: challengeDeleteMany,
      },
      replay: { deleteMany: replayDeleteMany },
      funnelEvent: { findMany: funnelFindMany, deleteMany: funnelDeleteMany },
      renderJob: { findMany: renderFindMany, deleteMany: renderDeleteMany },
      match: { findFirst: matchFindFirst },
    } as any;
    return {
      service: new CleanupService(prisma),
      prisma,
      roomFindMany,
      guestFindMany,
      roomDeleteMany,
      guestDeleteMany,
      challengeFindMany,
      challengeUpdateMany,
      challengeDeleteMany,
      replayDeleteMany,
      funnelFindMany,
      funnelDeleteMany,
      renderFindMany,
      renderDeleteMany,
      matchFindFirst,
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
    const { service, roomDeleteMany, guestDeleteMany } = makePrisma();
    await service.run();
    expect(roomDeleteMany).not.toHaveBeenCalled();
    expect(guestDeleteMany).not.toHaveBeenCalled();
  });

  it('does not allow one failing table to abort the rest of cleanup', async () => {
    const { service } = makePrisma();
    jest.spyOn(service as any, 'deleteExpiredRooms').mockRejectedValue(new Error('db down'));
    await expect(service.run()).resolves.toBeUndefined();
  });

  it('prunes old funnel events in bounded batches', async () => {
    const events = Array.from({ length: 500 }, (_, i) => ({ id: `event-${i}` }));
    const { service, prisma, funnelFindMany, funnelDeleteMany } = makePrisma();
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
    const { service, prisma, renderFindMany, renderDeleteMany } = makePrisma();
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
    const { service, prisma, funnelFindMany, renderFindMany } = makePrisma();
    prisma.hasOptionalTable.mockReturnValue(false);

    await service.run();

    expect(funnelFindMany).not.toHaveBeenCalled();
    expect(renderFindMany).not.toHaveBeenCalled();
  });

  describe('challenge retention', () => {
    it('expires newly lapsed challenges without deleting them', async () => {
      const { service, challengeFindMany, challengeUpdateMany, challengeDeleteMany } = makePrisma();

      await service.run();

      expect(challengeUpdateMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: expect.any(Date) }, status: 'ACTIVE' },
        data: { status: 'EXPIRED' },
      });
      expect(challengeFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'EXPIRED',
            expiresAt: { lt: expect.any(Date) },
          }),
        }),
      );
      expect(challengeDeleteMany).not.toHaveBeenCalled();
    });

    it('deletes expired challenges and attempts only after the retention grace period', async () => {
      const candidates = Array.from({ length: 500 }, (_, i) => ({
        id: `challenge-${i}`,
        replayId: `replay-${i}`,
      }));
      const { service, challengeFindMany, challengeDeleteMany, replayDeleteMany } = makePrisma();
      challengeFindMany.mockResolvedValue(candidates);
      challengeDeleteMany.mockResolvedValue({ count: 500 });
      replayDeleteMany.mockResolvedValue({ count: 500 });

      await service.run();

      const cutoff = challengeFindMany.mock.calls[0][0].where.expiresAt.lt as Date;
      expect(cutoff.getTime()).toBeLessThan(Date.now() - 23 * 60 * 60 * 1000);
      expect(challengeFindMany).toHaveBeenCalledWith({
        where: {
          status: 'EXPIRED',
          expiresAt: { lt: expect.any(Date) },
          replay: { dailyId: null },
        },
        select: { id: true, replayId: true },
        take: 500,
        orderBy: { expiresAt: 'asc' },
      });
      expect(challengeDeleteMany).toHaveBeenCalledWith({
        where: {
          id: { in: candidates.map(c => c.id) },
          status: 'EXPIRED',
          expiresAt: { lt: cutoff },
          replay: { dailyId: null },
        },
      });
      expect(replayDeleteMany).toHaveBeenCalledWith({
        where: {
          id: { in: candidates.map(c => c.replayId) },
          dailyId: null,
          turnId: null,
        },
      });
    });

    it('deletes challenges without a replay and skips replay deletion when none are linked', async () => {
      const { service, challengeFindMany, challengeDeleteMany, replayDeleteMany } = makePrisma();
      challengeFindMany.mockResolvedValue([{ id: 'challenge-1', replayId: null }]);
      challengeDeleteMany.mockResolvedValue({ count: 1 });

      await service.run();

      expect(challengeDeleteMany).toHaveBeenCalledTimes(1);
      expect(replayDeleteMany).not.toHaveBeenCalled();
    });

    it('rechecks daily and match replay predicates at delete time', async () => {
      const { service, challengeFindMany, challengeDeleteMany, replayDeleteMany } = makePrisma();
      challengeFindMany.mockResolvedValue([
        { id: 'challenge-1', replayId: 'replay-1' },
      ]);
      challengeDeleteMany.mockResolvedValue({ count: 0 });
      replayDeleteMany.mockResolvedValue({ count: 0 });

      await service.run();

      expect(challengeDeleteMany.mock.calls[0][0].where.replay).toEqual({ dailyId: null });
      expect(replayDeleteMany.mock.calls[0][0].where).toMatchObject({
        dailyId: null,
        turnId: null,
      });
      expect(challengeDeleteMany.mock.calls[0][0].where.id.in).toContain('challenge-1');
      expect(replayDeleteMany.mock.calls[0][0].where.id.in).toContain('replay-1');
    });
  });

  describe('leaderboard invalidation', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('refreshes snapshots once when a newly finished match is detected', async () => {
      const { service, matchFindFirst } = makePrisma();
      matchFindFirst.mockResolvedValue({ endedAt: new Date() });
      const refresh = jest.fn().mockResolvedValue(undefined);
      jest.spyOn(LeaderboardService, 'getRefreshDelegate').mockReturnValue(refresh);

      await service.run();

      expect(matchFindFirst).toHaveBeenCalledWith({
        where: { status: 'FINISHED', endedAt: { gt: expect.any(Date) } },
        orderBy: { endedAt: 'desc' },
        select: { endedAt: true },
      });
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('does not refresh again for matches already processed', async () => {
      const { service, matchFindFirst } = makePrisma();
      const endedAt = new Date();
      matchFindFirst.mockResolvedValueOnce({ endedAt }).mockResolvedValue(null);
      const refresh = jest.fn().mockResolvedValue(undefined);
      jest.spyOn(LeaderboardService, 'getRefreshDelegate').mockReturnValue(refresh);

      await service.run();
      await service.run();

      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('skips refresh when the leaderboard delegate is not registered yet', async () => {
      const { service, matchFindFirst } = makePrisma();
      matchFindFirst.mockResolvedValue({ endedAt: new Date() });
      jest.spyOn(LeaderboardService, 'getRefreshDelegate').mockReturnValue(null);

      await expect(service.run()).resolves.toBeUndefined();
    });

    it('does not let a failed refresh break cleanup', async () => {
      const { service, matchFindFirst } = makePrisma();
      matchFindFirst.mockResolvedValue({ endedAt: new Date() });
      const refresh = jest.fn().mockRejectedValue(new Error('snapshot failed'));
      jest.spyOn(LeaderboardService, 'getRefreshDelegate').mockReturnValue(refresh);

      await expect(service.run()).resolves.toBeUndefined();
    });
  });
});
