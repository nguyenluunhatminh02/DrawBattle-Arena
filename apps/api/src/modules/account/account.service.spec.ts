import { UnauthorizedException } from '@nestjs/common';
import { AccountService } from './account.service';

function makeService() {
  const prisma: any = {
    guestSession: {
      findUnique: jest.fn().mockResolvedValue({ id: 'guest-1', userId: null }),
      update: jest.fn().mockResolvedValue({}),
    },
    roomPlayer: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    roomBan: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'ban-1', roomId: 'room-a', userId: null },
        { id: 'ban-2', roomId: 'room-b', userId: 'user-1' },
        { id: 'ban-3', roomId: 'room-c', userId: 'other-user' },
      ]),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(async fn => fn(prisma)),
  };
  const jwtService = { verify: jest.fn().mockReturnValue({ sub: 'guest-1', type: 'guest' }) };
  const service = new AccountService(prisma as any, jwtService as any);
  return { service, prisma, jwtService };
}

describe('AccountService.linkGuestToUser', () => {
  it('expires and links the guest session, migrating room bans to the user', async () => {
    const { service, prisma } = makeService();

    await expect(service.linkGuestToUser('guest-1', 'user-1', 'token')).resolves.toEqual({
      success: true,
    });

    const sessionUpdate = prisma.guestSession.update.mock.calls[0][0];
    expect(sessionUpdate.where).toEqual({ id: 'guest-1' });
    expect(sessionUpdate.data.userId).toBe('user-1');
    expect(sessionUpdate.data.expiresAt).toBeInstanceOf(Date);
    expect(sessionUpdate.data.expiresAt.getTime()).toBe(0);

    expect(prisma.roomPlayer.updateMany).toHaveBeenCalledWith({
      where: { guestSessionId: 'guest-1', userId: null },
      data: { userId: 'user-1' },
    });
    expect(prisma.roomBan.update).toHaveBeenCalledWith({
      where: { id: 'ban-1' },
      data: { userId: 'user-1', guestSessionId: null },
    });
    expect(prisma.roomBan.update).toHaveBeenCalledWith({
      where: { id: 'ban-2' },
      data: { guestSessionId: null },
    });
    expect(prisma.roomBan.delete).toHaveBeenCalledWith({ where: { id: 'ban-3' } });
  });

  it('logs token verification failures without leaking the token', async () => {
    const { service, jwtService } = makeService();
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    jwtService.verify.mockImplementation(() => {
      throw new Error('invalid signature');
    });

    await expect(
      service.linkGuestToUser('guest-1', 'user-1', 'super-secret-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('super-secret-token');
  });
});
