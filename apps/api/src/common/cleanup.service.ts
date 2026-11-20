import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CleanupService.name);
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.interval = setInterval(() => void this.run(), 5 * 60 * 1000);
    setTimeout(() => void this.run(), 10_000);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
  }

  /** Hard cap for bulk delete batches; keeps each cleanup pass short. */
  private readonly BATCH_SIZE = 500;

  async run() {
    const now = new Date();
    const rooms = await this.safely('rooms', () => this.deleteExpiredRooms(now));
    const challenges = await this.safely('challenges', async () =>
      (await this.prisma.challenge.updateMany({
        where: { expiresAt: { lt: now }, status: 'ACTIVE' },
        data: { status: 'EXPIRED' },
      })).count,
    );
    // Soft-deleted RoomPlayer rows (leftAt IS NOT NULL) must not block guest
    // session cleanup; otherwise every guest who ever joined a room stays
    // in the DB forever. RoomBans intentionally do NOT block cleanup: they
    // reference the guest with ON DELETE SET NULL, and each pass is bounded.
    const guests = await this.safely('guest sessions', () => this.deleteExpiredGuests(now));
    if (rooms || challenges || guests) {
      this.logger.log(
        `Cleaned: ${rooms} rooms, ${challenges} challenges expired, ${guests} guest sessions`,
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
}
