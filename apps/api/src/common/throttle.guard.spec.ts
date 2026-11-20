import { ExecutionContext } from '@nestjs/common';
import { ThrottleGuard } from './throttle.guard';

describe('ThrottleGuard', () => {
  let guard: ThrottleGuard;
  const mockReflector = { get: jest.fn() } as any;

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
    guard = new ThrottleGuard(mockReflector);
    jest.clearAllMocks();
  });

  it('allows requests under limit', () => {
    mockReflector.get.mockReturnValue({ limit: 3, windowMs: 1000, keyPrefix: 'test' });
    const ctx = makeContext('1.2.3.4');
    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects requests over limit', () => {
    mockReflector.get.mockReturnValue({ limit: 2, windowMs: 1000, keyPrefix: 'test2' });
    const ctx = makeContext('5.6.7.8');
    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrow();
  });

  it('tracks different IPs independently', () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'test3' });
    const ctx1 = makeContext('10.0.0.1');
    const ctx2 = makeContext('10.0.0.2');
    expect(guard.canActivate(ctx1)).toBe(true);
    expect(guard.canActivate(ctx2)).toBe(true);
  });

  it('allows when no config present', () => {
    mockReflector.get.mockReturnValue(undefined);
    const ctx = makeContext('9.9.9.9');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('ignores client-supplied CF-Connecting-IP headers', () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'cf-test' });
    const ctxA = makeContext('127.0.0.1', { headers: { 'cf-connecting-ip': '1.1.1.1' } });
    const ctxB = makeContext('127.0.0.1', { headers: { 'cf-connecting-ip': '2.2.2.2' } });
    expect(guard.canActivate(ctxA)).toBe(true);
    // Both requests have the same req.ip; the spoofed header must not split buckets.
    expect(() => guard.canActivate(ctxB)).toThrow();
  });

  it('keys buckets by authenticated identity when available', () => {
    mockReflector.get.mockReturnValue({ limit: 1, windowMs: 1000, keyPrefix: 'identity-test' });
    const ctxA = makeContext('127.0.0.1', { user: { id: 'user-a' } });
    const ctxB = makeContext('127.0.0.1', { user: { id: 'user-b' } });
    expect(guard.canActivate(ctxA)).toBe(true);
    expect(guard.canActivate(ctxB)).toBe(true);
    expect(() => guard.canActivate(ctxA)).toThrow();
  });

  it('bounds the bucket map against rotating identities', () => {
    mockReflector.get.mockReturnValue({ limit: 100, windowMs: 60_000, keyPrefix: 'bounded' });
    const buckets = (guard as any).buckets as Map<string, unknown>;

    for (let i = 0; i < 10_020; i++) {
      guard.canActivate(makeContext('127.0.0.1', { user: { id: `rotating-${i}` } }));
    }

    expect(buckets.size).toBeLessThanOrEqual(10_000);
  });
});
