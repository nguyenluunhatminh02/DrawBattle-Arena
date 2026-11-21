import { ExecutionContext } from '@nestjs/common';
import { createClient } from 'redis';
import jwt from 'jsonwebtoken';
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
  const originalJwtSecret = process.env.JWT_SECRET;
  const JWT_SECRET = 'throttle-test-secret-at-least-32-characters';

  const makeContext = (
    ip: string,
    opts: {
      headers?: Record<string, string>;
      user?: { id?: string; type?: string };
      guest?: { sessionId?: string };
    } = {},
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
    process.env.JWT_SECRET = JWT_SECRET;
    guard = new ThrottleGuard(mockReflector);
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
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

  it('enforces an identity bucket independent of the IP bucket', async () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'identity-test' });
    // Distinct IPs keep the IP buckets separate, isolating the identity bucket.
    const ctxA = makeContext('127.0.0.1', { user: { id: 'user-a', type: 'user' } });
    const ctxB = makeContext('10.0.0.8', { user: { id: 'user-b', type: 'user' } });
    await expect(guard.canActivate(ctxA)).resolves.toBe(true);
    await expect(guard.canActivate(ctxB)).resolves.toBe(true);
    await expect(guard.canActivate(ctxA)).rejects.toThrow();
  });

  it('ignores a populated principal whose type is not explicitly user', async () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'untyped-principal' });
    const buckets = (guard as any).buckets as Map<string, unknown>;

    await expect(
      guard.canActivate(makeContext('127.0.0.1', { user: { id: 'user-a' } })),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(makeContext('127.0.0.1', { user: { id: 'user-b' } })),
    ).rejects.toThrow();
    await expect(
      guard.canActivate(makeContext('127.0.0.1', { user: { id: 'user-c', type: 'guest' } })),
    ).rejects.toThrow();

    // Every request consumed only the single IP bucket.
    expect([...buckets.keys()]).toHaveLength(1);
    expect([...buckets.keys()][0]).toContain('127.0.0.1');
    expect([...buckets.keys()][0]).not.toContain('identity');
  });

  it('keys buckets by bearer-token identity before route guards populate request.user', async () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'bearer-identity' });
    const tokenFor = (id: string) => jwt.sign({ sub: id, type: 'user' }, JWT_SECRET);
    // Different IPs keep the IP buckets independent of the identity bucket.
    const ctxA = makeContext('127.0.0.1', { headers: { authorization: `Bearer ${tokenFor('user-a')}` } });
    const ctxB = makeContext('10.0.0.8', { headers: { authorization: `Bearer ${tokenFor('user-b')}` } });
    await expect(guard.canActivate(ctxA)).resolves.toBe(true);
    await expect(guard.canActivate(ctxB)).resolves.toBe(true);
    await expect(guard.canActivate(ctxA)).rejects.toThrow();
  });

  it('falls back to IP for forged or invalid bearer tokens', async () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'bearer-invalid' });
    const forged = jwt.sign({ sub: 'attacker', type: 'user' }, 'a-different-secret-of-similar-length');
    const ctxA = makeContext('127.0.0.1', { headers: { authorization: `Bearer ${forged}` } });
    const ctxB = makeContext('127.0.0.1', { headers: { authorization: 'Bearer garbage' } });
    await expect(guard.canActivate(ctxA)).resolves.toBe(true);
    await expect(guard.canActivate(ctxB)).rejects.toThrow();
  });

  it('shares one IP bucket across many distinct guest tokens', async () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'guest-bucket' });
    const guestTokenFor = (id: string) => jwt.sign({ sub: id, type: 'guest' }, JWT_SECRET);

    // Guest sessions are freely mintable; rotating their sub must not split
    // the bucket for this IP.
    await expect(
      guard.canActivate(makeContext('127.0.0.1', {
        headers: { authorization: `Bearer ${guestTokenFor('guest-1')}` },
      })),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(makeContext('127.0.0.1', {
        headers: { authorization: `Bearer ${guestTokenFor('guest-2')}` },
      })),
    ).rejects.toThrow();
  });

  it('ignores populated guest principals when keying buckets', async () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'guest-principal' });

    await expect(
      guard.canActivate(makeContext('127.0.0.1', { guest: { sessionId: 'guest-session-1' } })),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(makeContext('127.0.0.1', { guest: { sessionId: 'guest-session-2' } })),
    ).rejects.toThrow();
  });

  it('does not let a verified user raise their limit by rotating IPs', async () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'user-ip-rotation' });
    const token = jwt.sign({ sub: 'user-a', type: 'user' }, JWT_SECRET);
    const forIp = (ip: string) =>
      makeContext(ip, { headers: { authorization: `Bearer ${token}` } });

    await expect(guard.canActivate(forIp('10.0.0.1'))).resolves.toBe(true);
    // The identity bucket was consumed by the first IP. Every later IP shares
    // it, so rotating IPs cannot buy another request for the same user.
    for (const ip of ['10.0.0.2', '10.0.0.3', '10.0.0.4']) {
      await expect(guard.canActivate(forIp(ip))).rejects.toThrow();
    }
  });

  it('shares one IP bucket across different verified identities', async () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'user-ip-cap' });
    const tokenFor = (id: string) => jwt.sign({ sub: id, type: 'user' }, JWT_SECRET);
    const forUser = (id: string) =>
      makeContext('127.0.0.1', { headers: { authorization: `Bearer ${tokenFor(id)}` } });

    await expect(guard.canActivate(forUser('user-a'))).resolves.toBe(true);
    // A different identity on the same IP still consumes that IP's single cap.
    await expect(guard.canActivate(forUser('user-b'))).rejects.toThrow();
  });

  it('gives an anonymous caller from one IP the same bucket', async () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'anon-ip-cap' });
    await expect(guard.canActivate(makeContext('127.0.0.1'))).resolves.toBe(true);
    await expect(guard.canActivate(makeContext('127.0.0.1'))).rejects.toThrow();
    await expect(guard.canActivate(makeContext('10.0.0.9'))).resolves.toBe(true);
  });

  it('treats forged tokens like anonymous callers from the same IP', async () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'forged-bucket' });
    const forgedFor = (id: string) =>
      jwt.sign({ sub: id, type: 'user' }, 'a-different-secret-of-similar-length');
    const buckets = (guard as any).buckets as Map<string, unknown>;

    await expect(
      guard.canActivate(makeContext('127.0.0.1', {
        headers: { authorization: `Bearer ${forgedFor('attacker-1')}` },
      })),
    ).resolves.toBe(true);
    // Many forged tokens and a plain anonymous caller share the IP bucket.
    for (const id of ['attacker-2', 'attacker-3', 'attacker-4']) {
      await expect(
        guard.canActivate(makeContext('127.0.0.1', {
          headers: { authorization: `Bearer ${forgedFor(id)}` },
        })),
      ).rejects.toThrow();
    }
    await expect(guard.canActivate(makeContext('127.0.0.1'))).rejects.toThrow();

    expect([...buckets.keys()]).toHaveLength(1);
    expect([...buckets.keys()][0]).toContain('127.0.0.1');
    expect([...buckets.keys()][0]).not.toContain('identity');
  });

  it('bounds the bucket map against rotating identities', async () => {
    mockReflector.get.mockReturnValue({ limit: 100, windowMs: 60_000, keyPrefix: 'bounded' });
    const buckets = (guard as any).buckets as Map<string, unknown>;

    for (let i = 0; i < 10_020; i++) {
      // A fresh IP per identity keeps the shared IP bucket out of the way.
      const ctx = makeContext(`10.1.${Math.floor(i / 250)}.${(i % 250) + 1}`, {
        user: { id: `rotating-${i}`, type: 'user' },
      });
      await guard.canActivate(ctx).catch(() => undefined);
    }

    expect(buckets.size).toBeLessThanOrEqual(10_000);
  });

  describe('with REDIS_URL configured', () => {
    const counts = new Map<string, number>();
    let evalMock: jest.Mock;
    let onMock: jest.Mock;
    let readyListeners: Array<() => void>;

    beforeEach(() => {
      counts.clear();
      readyListeners = [];
      onMock = jest.fn((event: string, listener: () => void) => {
        if (event === 'ready') readyListeners.push(listener);
      });
      evalMock = jest.fn(async (_script: string, opts: { keys: string[] }) => {
        // Mirror the Lua script: increment every key in one eval and return
        // counts in the same order as the keys.
        return opts.keys.map(key => {
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return count;
        });
      });
      (createClient as jest.Mock).mockReturnValue({
        on: onMock,
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

    it('increments both keys in one eval and rejects if either count exceeds the limit', async () => {
      mockReflector.get.mockReturnValue({ limit: 1, windowMs: 60_000, keyPrefix: 'redis-dual' });
      const redisGuard = new ThrottleGuard(mockReflector);
      const token = jwt.sign({ sub: 'user-a', type: 'user' }, JWT_SECRET);
      const forIp = (ip: string) =>
        makeContext(ip, { headers: { authorization: `Bearer ${token}` } });

      await expect(redisGuard.canActivate(forIp('10.2.0.1'))).resolves.toBe(true);
      // One eval for the whole request, carrying both keys in order.
      expect(evalMock).toHaveBeenCalledTimes(1);
      expect(evalMock.mock.calls[0][0]).toContain("redis.call('INCR'");
      expect(evalMock.mock.calls[0][0]).toContain("redis.call('PEXPIRE'");
      expect(evalMock.mock.calls[0][1].arguments).toEqual(['60000']);
      const keys: string[] = evalMock.mock.calls[0][1].keys;
      expect(keys).toHaveLength(2);
      expect(keys[0]).toContain(':ip:10.2.0.1');
      expect(keys[1]).toContain('identity:user:user-a');

      // A fresh IP has an unused IP bucket but the identity bucket is exhausted.
      await expect(redisGuard.canActivate(forIp('10.2.0.2'))).rejects.toThrow();
      expect(evalMock).toHaveBeenCalledTimes(2);
      expect(evalMock.mock.calls[1][1].keys[1]).toBe(keys[1]);

      // The identity bucket must have consumed the rejected request too.
      const identityCount = counts.get(keys[1]);
      expect(identityCount).toBe(2);
      await redisGuard.onModuleDestroy();
    });

    it('falls back after a Redis failure but retries Redis after the cooldown', async () => {
      jest.useFakeTimers();
      try {
        evalMock.mockRejectedValueOnce(new Error('redis down'));
        mockReflector.get.mockReturnValue({ limit: 1, windowMs: 60_000, keyPrefix: 'fallback' });
        const redisGuard = new ThrottleGuard(mockReflector);
        const ctx = makeContext('10.9.9.9');

        await expect(redisGuard.canActivate(ctx)).resolves.toBe(true);
        await expect(redisGuard.canActivate(ctx)).rejects.toThrow();
        expect(evalMock).toHaveBeenCalledTimes(1);
        expect((redisGuard as any).redisRetryAfter).toBeGreaterThan(Date.now());

        // Still cooling down: stay on local buckets, do not hammer Redis.
        await expect(redisGuard.canActivate(ctx)).rejects.toThrow();
        expect(evalMock).toHaveBeenCalledTimes(1);

        // After the cooldown a later request retries Redis and shared counting recovers.
        jest.setSystemTime(Date.now() + 30_000);
        await expect(redisGuard.canActivate(ctx)).resolves.toBe(true);
        expect(evalMock).toHaveBeenCalledTimes(2);
        expect((redisGuard as any).redisRetryAfter).toBe(0);
        await expect(redisGuard.canActivate(ctx)).rejects.toThrow();
        expect(evalMock).toHaveBeenCalledTimes(3);
        await redisGuard.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('extends the cooldown on every failure and does not clear it on a late success', async () => {
      jest.useFakeTimers();
      try {
        mockReflector.get.mockReturnValue({ limit: 10, windowMs: 60_000, keyPrefix: 'cooldown' });
        const redisGuard = new ThrottleGuard(mockReflector);
        const ctx = makeContext('10.9.9.20');

        evalMock.mockRejectedValueOnce(new Error('redis down'));
        await expect(redisGuard.canActivate(ctx)).resolves.toBe(true);
        const firstDeadline = (redisGuard as any).redisRetryAfter as number;
        expect(firstDeadline).toBe(Date.now() + 30_000);

        // Advance less than the full cooldown and exercise another failure via
        // a fresh guard sharing the same client. The deadline must move forward
        // rather than stay pinned to the first failure.
        jest.setSystemTime(Date.now() + 10_000);
        const secondGuard = new ThrottleGuard(mockReflector);
        evalMock.mockRejectedValueOnce(new Error('still down'));
        await expect(secondGuard.canActivate(ctx)).resolves.toBe(true);
        expect((secondGuard as any).redisRetryAfter).toBe(Date.now() + 30_000);
        expect((secondGuard as any).redisRetryAfter).toBeGreaterThan(firstDeadline);
        expect((redisGuard as any).redisRetryAfter).toBe(firstDeadline);

        // A success that arrives while a cooldown is still active must not
        // clear it. Start a deferred eval on the second guard (still inside its
        // extended cooldown), then resolve it before the deadline elapses.
        // The public canActivate path correctly skips Redis during cooldown, so
        // drive checkRedis directly for this race.
        const beforeSuccess = (secondGuard as any).redisRetryAfter as number;
        let resolveEval: (value: number[]) => void = () => undefined;
        evalMock.mockImplementationOnce(
          () => new Promise<number[]>(resolve => { resolveEval = resolve; }),
        );
        const pending = (secondGuard as any).checkRedis(
          ['cooldown:ip:10.9.9.20'], 60_000, 10,
        ) as Promise<boolean>;
        resolveEval([1]);
        await expect(pending).resolves.toBe(true);
        expect(evalMock).toHaveBeenCalledTimes(3);
        expect((secondGuard as any).redisRetryAfter).toBe(beforeSuccess);
        await expect(secondGuard.canActivate(ctx)).resolves.toBe(true);
        expect(evalMock).toHaveBeenCalledTimes(3);

        // Once the deadline passes, Redis resumes and a success clears the flag.
        jest.setSystemTime(beforeSuccess);
        await expect(secondGuard.canActivate(ctx)).resolves.toBe(true);
        expect(evalMock).toHaveBeenCalledTimes(4);
        expect((secondGuard as any).redisRetryAfter).toBe(0);
        await redisGuard.onModuleDestroy();
        await secondGuard.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('resumes Redis as soon as the client reports ready', async () => {
      evalMock.mockRejectedValueOnce(new Error('redis down'));
      mockReflector.get.mockReturnValue({ limit: 1, windowMs: 60_000, keyPrefix: 'fallback-ready' });
      const redisGuard = new ThrottleGuard(mockReflector);
      const ctx = makeContext('10.9.9.10');

      await expect(redisGuard.canActivate(ctx)).resolves.toBe(true);
      expect(evalMock).toHaveBeenCalledTimes(1);
      expect(readyListeners.length).toBeGreaterThan(0);

      readyListeners.forEach(listener => listener());
      expect((redisGuard as any).redisRetryAfter).toBe(0);
      await expect(redisGuard.canActivate(ctx)).resolves.toBe(true);
      expect(evalMock).toHaveBeenCalledTimes(2);
      await redisGuard.onModuleDestroy();
    });
  });
});
