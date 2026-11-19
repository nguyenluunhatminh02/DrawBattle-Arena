import { ExecutionContext } from '@nestjs/common';
import { ThrottleGuard } from './throttle.guard';

describe('ThrottleGuard', () => {
  let guard: ThrottleGuard;
  const mockReflector = { get: jest.fn() } as any;
  const makeContext = (ip: string): ExecutionContext =>
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
          headers: {},
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
});
