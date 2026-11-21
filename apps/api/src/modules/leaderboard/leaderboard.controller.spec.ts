import { Reflector } from '@nestjs/core';
import { THROTTLE_KEY, ThrottleConfig } from '../../common/throttle.guard';
import type { LeaderboardService } from './leaderboard.service';

// LeaderboardService pulls in @nestjs/schedule, which is ESM-only under Jest's
// CommonJS transform; the controller spec only needs its stubbed shape.
jest.mock('./leaderboard.service', () => ({ LeaderboardService: class {} }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LeaderboardController } = require('./leaderboard.controller') as typeof import('./leaderboard.controller');

describe('LeaderboardController', () => {
  const service = {
    getLeaderboard: jest.fn().mockResolvedValue({
      leaderboard: Array.from({ length: 200 }, (_, i) => ({
        rank: i + 1,
        userId: `user-${i}`,
        nickname: `Player ${i}`,
        points: 200 - i,
      })),
    }),
  } as unknown as LeaderboardService;
  const controller = new LeaderboardController(service);
  const reflector = new Reflector();

  it('publishes an explicit throttle config on the leaderboard list route', () => {
    const config = reflector.get<ThrottleConfig>(THROTTLE_KEY, controller.getLeaderboard);
    expect(config).toMatchObject({ limit: expect.any(Number), windowMs: expect.any(Number) });
    expect(config!.keyPrefix).toContain('leaderboard');
  });

  it('normalizes period and clamps the requested limit', async () => {
    const result = await controller.getLeaderboard('daily', '1000');
    expect(service.getLeaderboard).toHaveBeenCalledWith('daily');
    expect(result.period).toBe('daily');
    expect(result.entries).toHaveLength(100);

    const fallback = await controller.getLeaderboard(undefined, 'not-a-number');
    expect(service.getLeaderboard).toHaveBeenLastCalledWith('alltime');
    expect(fallback.entries).toHaveLength(50);
  });
});
