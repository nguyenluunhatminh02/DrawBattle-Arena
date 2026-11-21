import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class LeaderboardService implements OnModuleInit {
  private readonly logger = new Logger(LeaderboardService.name);
  /**
   * Late-bound delegate so the cleanup hook can trigger a refresh without
   * importing a cycle through the Nest module graph. The live instance
   * registers itself on init.
   */
  private static refreshDelegate: (() => Promise<void>) | null = null;

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    LeaderboardService.refreshDelegate = () => this.updateLeaderboards();
    try {
      await this.updateLeaderboards();
    } catch (err) {
      this.logger.error(
        'Initial leaderboard refresh failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Public invalidation hook: rebuild all periods after a match finishes.
   * Hourly cron remains the safety net if this hook cannot run.
   */
  async refreshAfterMatch(): Promise<void> {
    await this.updateLeaderboards();
  }

  /** Returns the registered instance's refresh callback, if initialised. */
  static getRefreshDelegate(): (() => Promise<void>) | null {
    return LeaderboardService.refreshDelegate;
  }

  @Cron(CronExpression.EVERY_HOUR)
  async updateLeaderboards() {
    await this.generateSnapshot('daily');
    await this.generateSnapshot('weekly');
    await this.generateSnapshot('alltime');
  }

  private async generateSnapshot(period: 'daily' | 'weekly' | 'alltime') {
    const now = new Date();
    let startDate: Date | undefined;

    if (period === 'daily') {
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);
    } else if (period === 'weekly') {
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 7);
    }

    // The all-time board must not silently truncate to the most recent 2000
    // matches: that would exclude veteran players. Daily/weekly windows stay
    // capped to keep the hourly job bounded.
    const matches = await this.prisma.match.findMany({
      where: {
        status: 'FINISHED',
        ...(startDate ? { endedAt: { gte: startDate } } : {}),
      },
      orderBy: { endedAt: 'desc' },
      ...(startDate ? { take: 2000 } : {}),
      include: {
        scores: {
          include: { player: { include: { user: { select: { id: true, nickname: true } } } } },
        },
      },
    });

    const byUser = new Map<string, { nickname: string; points: number }>();
    for (const match of matches) {
      const userIds = new Set(
        match.scores.map(s => s.player.user?.id).filter((id): id is string => !!id),
      );
      if (userIds.size < 2) continue;
      for (const score of match.scores) {
        const user = score.player.user;
        if (!user) continue;
        const existing = byUser.get(user.id);
        if (existing) {
          existing.points += score.points;
        } else {
          byUser.set(user.id, { nickname: user.nickname, points: score.points });
        }
      }
    }

    const ranked = Array.from(byUser.entries())
      .sort((a, b) => b[1].points - a[1].points)
      .slice(0, 100);

    const batchId = `lb_${period}_${Date.now()}`;
    const newData = ranked.map(([userId, entry], index) => ({
      id: `${batchId}_${index}`,
      period,
      rank: index + 1,
      userId,
      nickname: entry.nickname,
      points: entry.points,
      wins: 0,
    }));

    await this.prisma.$transaction(async (tx) => {
      if (newData.length > 0) {
        await tx.leaderboardSnapshot.createMany({ data: newData });
      }
      await tx.leaderboardSnapshot.deleteMany({
        where: {
          period,
          id: { notIn: newData.map(d => d.id) },
        },
      });
    });
  }

  async getLeaderboard(period: 'daily' | 'weekly' | 'alltime' = 'alltime') {
    let snapshots = await this.prisma.leaderboardSnapshot.findMany({
      where: { period },
      orderBy: [{ rank: 'asc' }, { id: 'asc' }],
      take: 100,
    });

    if (snapshots.length === 0) {
      await this.generateSnapshot(period);
      snapshots = await this.prisma.leaderboardSnapshot.findMany({
        where: { period },
        orderBy: { rank: 'asc' },
        take: 100,
      });
    }

    return { period, leaderboard: snapshots };
  }
}
