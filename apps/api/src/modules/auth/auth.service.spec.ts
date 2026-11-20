import { AuthService } from './auth.service';

function makeService() {
  const prisma = {
    guestSession: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'guest-1',
        expiresAt: new Date(Date.now() + 60_000),
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'user-1', nickname: 'Alice', role: 'USER' }),
    },
  };
  const jwt = { verify: jest.fn() };
  const service = new AuthService(prisma as any, jwt as any);
  return { service, prisma, jwt };
}

describe('AuthService token validation', () => {
  it('rejects a guest token whose session was expired by linking', async () => {
    const { service, prisma, jwt } = makeService();
    prisma.guestSession.findUnique.mockResolvedValue({ id: 'guest-1', expiresAt: new Date(0) });
    jwt.verify.mockReturnValue({ sub: 'guest-1', type: 'guest', nickname: 'Guest' });

    await expect(service.validateGuestToken('linked-guest-token')).resolves.toBeNull();
    expect(prisma.guestSession.update).not.toHaveBeenCalled();
  });

  it('logs guest validation failures without logging the token', async () => {
    const { service, jwt } = makeService();
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    jwt.verify.mockImplementation(() => {
      throw new Error('jwt malformed');
    });

    await expect(service.validateGuestToken('secret-guest-token')).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-guest-token');
  });

  it('logs user validation failures without logging the token', async () => {
    const { service, jwt } = makeService();
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    jwt.verify.mockReturnValue({ sub: 'user-1', type: 'user' });

    await expect(service.validateUserToken('secret-user-token')).resolves.not.toBeNull();

    jwt.verify.mockImplementation(() => {
      throw new Error('jwt expired');
    });
    await expect(service.validateUserToken('secret-user-token')).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-user-token');
  });
});
