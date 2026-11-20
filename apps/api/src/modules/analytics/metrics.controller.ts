import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../../common/admin.guard';
import { metricSnapshot } from '../../common/metrics-counters';
import { PrismaService } from '../../prisma/prisma.service';
import { ReplayJobService } from '../replay/replay-jobs';
import { RedisAdapterService } from '../socket/redis-adapter.service';

/**
 * Minimal operational endpoint. Admin-only because it exposes instance and
 * backlog counts; no new dependencies and no DB writes on the request path.
 */
@Controller('metrics')
@UseGuards(AdminGuard)
export class MetricsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly replayJobs: ReplayJobService,
    private readonly redisAdapter: RedisAdapterService,
  ) {}

  @Get()
  async snapshot() {
    const [activeRooms, replayBacklog, counters] = await Promise.all([
      this.countActiveRooms(),
      this.replayJobs.pendingCount().catch(() => -1),
      Promise.resolve(metricSnapshot()),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      counts: {
        replayBacklog,
        activeRooms,
        throttleRejects: counters.throttle_rejects_total ?? 0,
      },
      counters,
      redisAdapterEnabled: this.redisAdapter.isEnabled(),
    };
  }

  private async countActiveRooms(): Promise<number> {
    try {
      return await this.prisma.room.count({ where: { status: { in: ['WAITING', 'PLAYING'] } } });
    } catch {
      // Metrics must never take down the endpoint when the DB is degraded.
      return -1;
    }
  }
}
