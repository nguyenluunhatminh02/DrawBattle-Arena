import { ExecutionContext } from '@nestjs/common';
import { createClient } from 'redis';
import { ThrottleGuard } from './throttle.guard';

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    isReady: false,
    isOpen: false,
    eval: jest.fn(),
  })),
}));

describe('ThrottleGuard', () => {
  let guard: ThrottleGuard;
  const mockReflector = { get: jest.fn() } as any;
  const originalRedisUrl = process.env.REDIS_URL;

  const makeContext = (
    ip: string,
    opts: { headers?: Record<string, string>; user?: { id?: string }; guest?: { sessionId?: string } } = {},
  ): ExecutionContext =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      getArgs: () => [],
      getArgByIndex: () => undefined,
      switchToRpc: () => undefined as any,
      switchToWs: () => undefined as any,
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          ip,
          headers: opts.headers ?? {},
          user: opts.user,
          guest: opts.guest,
        }),
      }),
    } as unknown as ExecutionContext);

  beforeEach(() => {
    delete process.env.REDIS_URL;
    guard = new ThrottleGuard(mockReflector);
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  it('allows requests under limit', async () => {
    mockReflector.get.mockReturnValue({ limit: 3, windowMs: 1000, keyPrefix: 'test' });
    const ctx = makeContext('1.2.3.4');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects requests over limit', async () => {
    mockReflector.get.mockReturnValue({ limit: 2, windowMs: 1000, keyPrefix: 'test2' });
    const ctx = makeContext('5.6.7.8');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toThrow();
  });

  it('tracks different IPs independently', async () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'test3' });
    const ctx1 = makeContext('10.0.0.1');
    const ctx2 = makeContext('10.0.0.2');
    await expect(guard.canActivate(ctx1)).resolves.toBe(true);
    await expect(guard.canActivate(ctx2)).resolves.toBe(true);
  });

  it('allows when no config present', async () => {
    mockReflector.get.mockReturnValue(undefined);
    const ctx = makeContext('9.9.9.9');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('ignores client-supplied CF-Connecting-IP headers', async () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'cf-test' });
    const ctxA = makeContext('127.0.0.1', { headers: { 'cf-connecting-ip': '1.1.1.1' } });
    const ctxB = makeContext('127.0.0.1', { headers: { 'cf-connecting-ip': '2.2.2.2' } });
    await expect(guard.canActivate(ctxA)).resolves.toBe(true);
    // Both requests have the same req.ip; the spoofed header must not split buckets.
    await expect(guard.canActivate(ctxB)).rejects.toThrow();
  });

  it('keys buckets by authenticated identity when available', async () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'identity-test' });
    const ctxA = makeContext('127.0.0.1', { user: { id: 'user-a' } });
    const ctxB = makeContext('127.0.0.1', { user: { id: 'user-b' } });
    await expect(guard.canActivate(ctxA)).resolves.toBe(true);
    await expect(guard.canActivate(ctxB)).resolves.toBe(true);
    await expect(guard.canActivate(ctxA)).rejects.toThrow();
  });

  it('bounds the bucket map against rotating identities', async () => {
    mockReflector.get.mockReturnValue({ limit: 100, windowMs: 60_000, keyPrefix: 'bounded' });
    const buckets = (guard as any).buckets as Map<string, unknown>;

    for (let i = 0; i < 10_020; i++) {
      await guard.canActivate(makeContext('127.0.0.1', { user: { id: `rotating-${i}` } }));
    }

    expect(buckets.size).toBeLessThanOrEqual(10_000);
  });

  describe('with REDIS_URL configured', () => {
    const counts = new Map<string, number>();
    let evalMock: jest.Mock;

    beforeEach(() => {
      counts.clear();
      evalMock = jest.fn(async (_script: string, opts: { keys: string[] }) => {
        const key = opts.keys[0];
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return [count, 60_000];
      });
      (createClient as jest.Mock).mockReturnValue({
        on: jest.fn(),
        connect: jest.fn().mockResolvedValue(undefined),
        quit: jest.fn().mockResolvedValue(undefined),
        isReady: true,
        isOpen: true,
        eval: evalMock,
      });
      process.env.REDIS_URL = 'redis://localhost:6379';
    });

    it('shares one bucket across guard instances', async () => {
      const reflectorA = { get: jest.fn().mockReturnValue({ limit: 2, windowMs: 60_000, keyPrefix: 'shared' }) } as any;
      const reflectorB = { get: jest.fn().mockReturnValue({ limit: 2, windowMs: 60_000, keyPrefix: 'shared' }) } as any;
      const guardA = new ThrottleGuard(reflectorA);
      const guardB = new ThrottleGuard(reflectorB);
      const ctx = makeContext('10.1.2.3');

      await expect(guardA.canActivate(ctx)).resolves.toBe(true);
      await expect(guardB.canActivate(ctx)).resolves.toBe(true);
      await expect(guardA.canActivate(ctx)).rejects.toThrow();
      expect(evalMock).toHaveBeenCalledTimes(3);
      expect(evalMock.mock.calls[0][0]).toContain("redis.call('INCR'");
      await guardA.onModuleDestroy();
      await guardB.onModuleDestroy();
    });

    it('falls back to in-memory buckets when a Redis command fails', async () => {
      evalMock.mockRejectedValueOnce(new Error('redis down'));
      mockReflector.get.mockReturnValue({ limit: 1, windowMs: 60_000, keyPrefix: 'fallback' });
      const redisGuard = new ThrottleGuard(mockReflector);
      const ctx = makeContext('10.9.9.9');

      await expect(redisGuard.canActivate(ctx)).resolves.toBe(true);
      await expect(redisGuard.canActivate(ctx)).rejects.toThrow();
      expect((redisGuard as any).redisDisabled).toBe(true);
      expect(evalMock).toHaveBeenCalledTimes(1);
      await redisGuard.onModuleDestroy();
    });
  });
});
