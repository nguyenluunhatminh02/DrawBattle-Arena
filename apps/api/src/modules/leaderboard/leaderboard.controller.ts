import { Controller, Get, Query } from '@nestjs/common';
import { LeaderboardService } from './leaderboard.service';
import { Throttle } from '../../common/throttle.guard';

const PERIODS = {
  daily: 'daily',
  weekly: 'weekly',
  alltime: 'alltime',
  'all-time': 'alltime',
} as const;

@Controller(['leaderboards', 'leaderboard'])
export class LeaderboardController {
  constructor(private leaderboardService: LeaderboardService) {}

  @Get()
  @Throttle({ limit: 60, windowMs: 60_000, keyPrefix: 'leaderboard-list' })
  async getLeaderboard(@Query('period') period?: string, @Query('limit') limit?: string) {
    const normalized = PERIODS[(period ?? 'alltime') as keyof typeof PERIODS] ?? 'alltime';
    const take = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 100);
    const { leaderboard } = await this.leaderboardService.getLeaderboard(normalized);
    return {
      period: period ?? 'all-time',
      entries: leaderboard.slice(0, take).map(s => ({
        rank: s.rank,
        playerId: s.userId,
        nickname: s.nickname,
        points: s.points,
      })),
    };
  }
}