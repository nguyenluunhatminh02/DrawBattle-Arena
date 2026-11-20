import { BadRequestException } from '@nestjs/common';
import { RoomService } from './room.service';

describe('RoomService.joinRoom', () => {
  const makeService = (room: any) => {
    const tx = {
      room: { findUnique: jest.fn().mockResolvedValue(room) },
      roomPlayer: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    const prisma = { $transaction: jest.fn(fn => fn(tx)) } as any;
    return { service: new RoomService(prisma), tx };
  };

  const passwordHash = require('crypto').createHash('sha256')
    .update('room-pwd:secret')
    .digest('hex');

  const room = (overrides: Record<string, unknown> = {}) => ({
    id: 'room-1',
    code: 'ABC123',
    status: 'WAITING',
    expiresAt: new Date(Date.now() + 60_000),
    settings: { maxPlayers: 8, passwordHash },
    players: [
      {
        id: 'player-1',
        userId: null,
        guestSessionId: 'session-1',
        nicknameSnapshot: 'Alice',
        leftAt: null,
      },
    ],
    ...overrides,
  });

  it('rejects password-free rejoin for an active session', async () => {
    const { service } = makeService(room());
    await expect(
      service.joinRoom('ABC123', 'Alice', 'session-1', null, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows reconnect with the correct password', async () => {
    const { service } = makeService(room());
    await expect(
      service.joinRoom('ABC123', 'Alice', 'session-1', null, 'secret'),
    ).resolves.toEqual({ roomId: 'room-1', roomCode: 'ABC123', playerId: 'player-1' });
  });

  it('reactivates a soft-deleted row on rejoin', async () => {
    const leftRoom = room({
      players: [
        {
          id: 'player-1',
          userId: null,
          guestSessionId: 'session-1',
          nicknameSnapshot: 'Alice',
          leftAt: new Date(),
        },
      ],
    });
    const { service, tx } = makeService(leftRoom);
    tx.roomPlayer.update.mockResolvedValue({ id: 'player-1' });
    await expect(
      service.joinRoom('ABC123', 'Alice', 'session-1', null, 'secret'),
    ).resolves.toEqual({ roomId: 'room-1', roomCode: 'ABC123', playerId: 'player-1' });
    expect(tx.roomPlayer.update).toHaveBeenCalledWith({
      where: { id: 'player-1' },
      data: { leftAt: null, nicknameSnapshot: 'Alice' },
    });
  });
});
