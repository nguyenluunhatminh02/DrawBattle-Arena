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

  async run() {
    const now = new Date();
    try {
      const rooms = await this.prisma.room.deleteMany({
        where: { expiresAt: { lt: now }, matches: { none: {} } },
      });
      const challenges = await this.prisma.challenge.updateMany({
        where: { expiresAt: { lt: now }, status: 'ACTIVE' },
        data: { status: 'EXPIRED' },
      });
      const guests = await this.prisma.guestSession.deleteMany({
        where: {
          expiresAt: { lt: now },
          roomPlayers: { none: {} },
          dailyChallengeAttempts: { none: {} },
        },
      });
      if (rooms.count || challenges.count || guests.count) {
        this.logger.log(
          `Cleaned: ${rooms.count} rooms, ${challenges.count} challenges expired, ${guests.count} guest sessions`,
        );
      }
    } catch (err) {
      this.logger.error('Cleanup failed', err instanceof Error ? err.message : String(err));
    }
  }
}
