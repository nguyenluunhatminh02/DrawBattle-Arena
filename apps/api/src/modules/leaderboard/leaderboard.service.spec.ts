// Jest in this repo does not transform @nestjs/schedule's ESM build; the
// decorator is irrelevant to these service tests.
jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_HOUR: '0 * * * *' },
}));

import { LeaderboardService } from './leaderboard.service';

describe('LeaderboardService invalidation hook', () => {
  const makePrisma = () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const leaderboardFindMany = jest.fn().mockResolvedValue([]);
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const tx = {
      leaderboardSnapshot: { createMany, deleteMany },
    };
    const transaction = jest.fn().mockImplementation(async (fn: (client: typeof tx) => Promise<void>) => fn(tx));
    const prisma = {
      match: { findMany },
      leaderboardSnapshot: { findMany: leaderboardFindMany },
      $transaction: transaction,
    } as any;
    return { service: new LeaderboardService(prisma), prisma, findMany, transaction, createMany, deleteMany };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers a refresh delegate on module init', async () => {
    const { service } = makePrisma();
    const update = jest.spyOn(service, 'updateLeaderboards').mockResolvedValue(undefined);

    await service.onModuleInit();

    const delegate = LeaderboardService.getRefreshDelegate();
    expect(delegate).not.toBeNull();
    await delegate!();
    expect(update).toHaveBeenCalled();
  });

  it('refreshAfterMatch rebuilds all three periods', async () => {
    const { service, findMany, transaction } = makePrisma();

    await service.refreshAfterMatch();

    expect(findMany).toHaveBeenCalledTimes(3);
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls.map(call => call[0].where.status)).toEqual([
      'FINISHED',
      'FINISHED',
      'FINISHED',
    ]);
  });

  it('rebuilds snapshots when a finished match changes the ranking', async () => {
    const prisma = {
      match: {
        findMany: jest.fn().mockResolvedValue([
          {
            scores: [
              { points: 10, player: { user: { id: 'u1', nickname: 'Alice' } } },
              { points: 5, player: { user: { id: 'u2', nickname: 'Bob' } } },
            ],
          },
        ]),
      },
      leaderboardSnapshot: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: any) => Promise<void>) =>
        fn({
          leaderboardSnapshot: {
            createMany: jest.fn().mockResolvedValue({ count: 2 }),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
        }),
      ),
    } as any;
    const service = new LeaderboardService(prisma);

    await service.refreshAfterMatch();

    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('logs and swallows initial refresh failures', async () => {
    const { service } = makePrisma();
    jest.spyOn(service, 'updateLeaderboards').mockRejectedValue(new Error('db down'));
    const loggerError = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalled();
  });
});
