import { CleanupService } from './cleanup.service';

describe('CleanupService retention', () => {
  const makePrisma = (rooms: unknown[], guests: unknown[], roomDeleteCount = 0, guestDeleteCount = 0) => {
    const roomFindMany = jest.fn().mockResolvedValue(rooms);
    const guestFindMany = jest.fn().mockResolvedValue(guests);
    const roomDeleteMany = jest.fn().mockResolvedValue({ count: roomDeleteCount });
    const guestDeleteMany = jest.fn().mockResolvedValue({ count: guestDeleteCount });
    const prisma = {
      room: { findMany: roomFindMany, deleteMany: roomDeleteMany },
      guestSession: { findMany: guestFindMany, deleteMany: guestDeleteMany },
      challenge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    } as any;
    return { service: new CleanupService(prisma), prisma, roomFindMany, guestFindMany, roomDeleteMany, guestDeleteMany };
  };

  it('caps each cleanup pass and rechecks the predicate on delete', async () => {
    const rooms = Array.from({ length: 500 }, (_, i) => ({ id: `room-${i}` }));
    const guests = Array.from({ length: 500 }, (_, i) => ({ id: `guest-${i}` }));
    const { service, roomDeleteMany, guestDeleteMany } = makePrisma(rooms, guests, 500, 480);

    await service.run();

    expect(roomDeleteMany.mock.calls[0][0].where.id.in).toHaveLength(500);
    expect(roomDeleteMany.mock.calls[0][0].where.matches).toEqual({ none: {} });
    expect(guestDeleteMany.mock.calls[0][0].where).toMatchObject({
      expiresAt: { lt: expect.any(Date) },
      roomPlayers: { every: { leftAt: { not: null } } },
      dailyChallengeAttempts: { none: {} },
    });
  });

  it('skips deletes when there are no expired candidates', async () => {
    const { service, roomDeleteMany, guestDeleteMany } = makePrisma([], []);
    await service.run();
    expect(roomDeleteMany).not.toHaveBeenCalled();
    expect(guestDeleteMany).not.toHaveBeenCalled();
  });

  it('does not allow one failing table to abort the rest of cleanup', async () => {
    const { service } = makePrisma([], []);
    jest.spyOn(service as any, 'deleteExpiredRooms').mockRejectedValue(new Error('db down'));
    await expect(service.run()).resolves.toBeUndefined();
  });
});
