import { MetricsController } from './metrics.controller';
import { recordMetric, metricSnapshot } from '../../common/metrics-counters';

describe('MetricsController', () => {
  it('reports backlog, active rooms, throttle rejects and adapter state', async () => {
    const prisma = { room: { count: jest.fn().mockResolvedValue(7) } } as any;
    const replayJobs = { pendingCount: jest.fn().mockResolvedValue(3) } as any;
    const redisAdapter = { isEnabled: jest.fn().mockReturnValue(true) } as any;
    const controller = new MetricsController(prisma, replayJobs, redisAdapter);
    recordMetric('throttle_rejects_total', 5);

    const snapshot = await controller.snapshot();

    expect(snapshot.counts).toMatchObject({
      replayBacklog: 3,
      activeRooms: 7,
      throttleRejects: 5,
    });
    expect(snapshot.redisAdapterEnabled).toBe(true);
    expect(metricSnapshot().throttle_rejects_total).toBeGreaterThanOrEqual(5);
    expect(prisma.room.count).toHaveBeenCalledWith({
      where: { status: { in: ['WAITING', 'PLAYING'] } },
    });
  });

  it('uses -1 when a data source is unavailable', async () => {
    const prisma = { room: { count: jest.fn().mockRejectedValue(new Error('db down')) } } as any;
    const replayJobs = { pendingCount: jest.fn().mockRejectedValue(new Error('no store')) } as any;
    const redisAdapter = { isEnabled: jest.fn().mockReturnValue(false) } as any;
    const controller = new MetricsController(prisma, replayJobs, redisAdapter);

    const snapshot = await controller.snapshot();

    expect(snapshot.counts.replayBacklog).toBe(-1);
    expect(snapshot.counts.activeRooms).toBe(-1);
    expect(snapshot.redisAdapterEnabled).toBe(false);
  });
});
