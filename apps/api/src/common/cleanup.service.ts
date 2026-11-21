import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderboardService } from '../modules/leaderboard/leaderboard.service';

@Injectable()
export class CleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CleanupService.name);
  private interval: NodeJS.Timeout | null = null;
  /** High-water mark for matches whose scores have already been snapshotted. */
  private lastRefreshedMatchEnd: Date;

  constructor(private readonly prisma: PrismaService) {
    // Only matches finishing after boot should trigger a refresh: the
    // leaderboard service already rebuilds all periods on module init.
    this.lastRefreshedMatchEnd = new Date();
  }

  onModuleInit() {
    this.interval = setInterval(() => void this.run(), 5 * 60 * 1000);
    setTimeout(() => void this.run(), 10_000);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
  }

  /** Hard cap for bulk delete batches; keeps each cleanup pass short. */
  private readonly BATCH_SIZE = 500;
  /** Product funnel events are analytics only: keep 30 days of history. */
  private readonly FUNNEL_EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  /** Failed render jobs have exhausted their retries and are no longer useful. */
  private readonly RENDER_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  /**
   * Expired quick challenges stay queryable for a grace period before their
   * rows (and their attempts/replays) are pruned.
   */
  private readonly CHALLENGE_RETENTION_MS = 24 * 60 * 60 * 1000;

  /**
   * Rebuild leaderboard snapshots when a match finishes. Uses the live
   * LeaderboardService delegate rather than module injection so CommonModule
   * and LeaderboardModule do not form a circular dependency. The hourly cron
   * remains the fallback if the delegate is not registered yet.
   */
  async refreshLeaderboards(): Promise<void> {
    const delegate = LeaderboardService.getRefreshDelegate();
    if (!delegate) return;
    try {
      await delegate();
    } catch (err) {
      this.logger.error(
        'Leaderboard refresh failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Detect newly finished matches and refresh snapshots at most once per pass. */
  private async invalidateLeaderboardsForFinishedMatches(): Promise<void> {
    const latest = await this.prisma.match.findFirst({
      where: { status: 'FINISHED', endedAt: { gt: this.lastRefreshedMatchEnd } },
      orderBy: { endedAt: 'desc' },
      select: { endedAt: true },
    });
    if (!latest?.endedAt) return;
    this.lastRefreshedMatchEnd = latest.endedAt;
    await this.refreshLeaderboards();
  }

  async run() {
    const now = new Date();
    await this.safely('finished matches', async () => {
      await this.invalidateLeaderboardsForFinishedMatches();
      return 0;
    });
    const rooms = await this.safely('rooms', () => this.deleteExpiredRooms(now));
    const challenges = await this.safely('challenges', async () =>
      (await this.prisma.challenge.updateMany({
        where: { expiresAt: { lt: now }, status: 'ACTIVE' },
        data: { status: 'EXPIRED' },
      })).count,
    );
    const prunedChallenges = await this.safely('expired challenges', () => this.pruneExpiredChallenges(now));
    // Soft-deleted RoomPlayer rows (leftAt IS NOT NULL) must not block guest
    // session cleanup; otherwise every guest who ever joined a room stays
    // in the DB forever. RoomBans intentionally do NOT block cleanup: they
    // reference the guest with ON DELETE SET NULL, and each pass is bounded.
    const guests = await this.safely('guest sessions', () => this.deleteExpiredGuests(now));
    const funnelEvents = await this.safely('funnel events', () => this.deleteOldFunnelEvents(now));
    const renderJobs = await this.safely('render jobs', () => this.deleteOldRenderJobs(now));
    if (rooms || challenges || prunedChallenges || guests || funnelEvents || renderJobs) {
      this.logger.log(
        `Cleaned: ${rooms} rooms, ${challenges} challenges expired, ${prunedChallenges} expired challenges pruned, ` +
          `${guests} guest sessions, ${funnelEvents} funnel events, ${renderJobs} render jobs`,
      );
    }
  }

  private async safely(label: string, task: () => Promise<number>): Promise<number> {
    try {
      return await task();
    } catch (err) {
      this.logger.error(`Cleanup failed for ${label}`, err instanceof Error ? err.message : String(err));
      return 0;
    }
  }

  /**
   * Quick challenges (and their attempts/replays) are pruned only after a
   * grace period. Daily-linked replays and match replays are never touched:
   * daily challenges reference replays by unique `dailyId`, and finished
   * match history references them through `turnId`. Both predicates are
   * rechecked at delete time to close the race where a replay is linked
   * between SELECT and DELETE. ChallengeAttempt rows cascade on delete.
   */
  private async pruneExpiredChallenges(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.CHALLENGE_RETENTION_MS);
    const candidates = await this.prisma.challenge.findMany({
      where: {
        status: 'EXPIRED',
        expiresAt: { lt: cutoff },
        replay: { dailyId: null },
      },
      select: { id: true, replayId: true },
      take: this.BATCH_SIZE,
      orderBy: { expiresAt: 'asc' },
    });
    if (candidates.length === 0) return 0;

    const ids = candidates.map(challenge => challenge.id);
    const result = await this.prisma.challenge.deleteMany({
      where: {
        id: { in: ids },
        status: 'EXPIRED',
        expiresAt: { lt: cutoff },
        replay: { dailyId: null },
      },
    });

    // Delete replays only after their challenge row is gone, so a replay
    // still linked to a live challenge is never removed early.
    const replayIds = candidates
      .map(challenge => challenge.replayId)
      .filter((id): id is string => Boolean(id));
    if (replayIds.length > 0) {
      await this.prisma.replay.deleteMany({
        where: { id: { in: replayIds }, dailyId: null, turnId: null },
      });
    }
    return result.count;
  }

  private async deleteExpiredRooms(now: Date): Promise<number> {
    // Only rooms with no matches are safe to hard-delete. A room with matches
    // still owns score rows and is retained for history until explicitly
    // archived; this avoids cascading away results still used by leaderboards.
    const candidates = await this.prisma.room.findMany({
      where: { expiresAt: { lt: now }, matches: { none: {} } },
      select: { id: true },
      take: this.BATCH_SIZE,
      orderBy: { expiresAt: 'asc' },
    });
    if (candidates.length === 0) return 0;
    const result = await this.prisma.room.deleteMany({
      where: { id: { in: candidates.map(room => room.id) }, matches: { none: {} } },
    });
    return result.count;
  }

  private async deleteExpiredGuests(now: Date): Promise<number> {
    const candidates = await this.prisma.guestSession.findMany({
      where: {
        expiresAt: { lt: now },
        roomPlayers: { every: { leftAt: { not: null } } },
        dailyChallengeAttempts: { none: {} },
      },
      select: { id: true },
      take: this.BATCH_SIZE,
      orderBy: { expiresAt: 'asc' },
    });
    if (candidates.length === 0) return 0;
    // Re-check the "every player left" predicate inside the delete so a guest
    // who reconnects between SELECT and DELETE cannot be removed.
    const result = await this.prisma.guestSession.deleteMany({
      where: {
        id: { in: candidates.map(guest => guest.id) },
        expiresAt: { lt: now },
        roomPlayers: { every: { leftAt: { not: null } } },
        dailyChallengeAttempts: { none: {} },
      },
    });
    return result.count;
  }

  /** Bounded by id so a missing optional table is a logged no-op, not a crash. */
  private async deleteOldFunnelEvents(now: Date): Promise<number> {
    if (!this.prisma.hasOptionalTable?.('funnelEvent')) return 0;
    const cutoff = new Date(now.getTime() - this.FUNNEL_EVENT_TTL_MS);
    const candidates = await this.prisma.funnelEvent.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: this.BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });
    if (candidates.length === 0) return 0;
    const result = await this.prisma.funnelEvent.deleteMany({
      where: { id: { in: candidates.map(event => event.id) }, createdAt: { lt: cutoff } },
    });
    return result.count;
  }

  /** Keep queued/running work intact; only prune old terminal failures. */
  private async deleteOldRenderJobs(now: Date): Promise<number> {
    if (!this.prisma.hasOptionalTable?.('renderJob')) return 0;
    const cutoff = new Date(now.getTime() - this.RENDER_JOB_TTL_MS);
    const candidates = await this.prisma.renderJob.findMany({
      where: { state: 'failed', updatedAt: { lt: cutoff } },
      select: { id: true },
      take: this.BATCH_SIZE,
      orderBy: { updatedAt: 'asc' },
    });
    if (candidates.length === 0) return 0;
    const result = await this.prisma.renderJob.deleteMany({
      where: {
        id: { in: candidates.map(job => job.id) },
        state: 'failed',
        updatedAt: { lt: cutoff },
      },
    });
    return result.count;
  }
}
