import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RoomService } from './room.service';

describe('RoomService.joinRoom', () => {
  const makeService = (room: any, ban: unknown = null) => {
    const tx = {
      room: { findUnique: jest.fn().mockResolvedValue(room) },
      roomBan: { findFirst: jest.fn().mockResolvedValue(ban) },
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

  it('rejects a banned guest identity before creating or reactivating a player', async () => {
    const { service, tx } = makeService(room(), { id: 'ban-1' });
    await expect(
      service.joinRoom('ABC123', 'Alice', 'session-1', null, 'secret'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.roomBan.findFirst).toHaveBeenCalledWith({
      where: { roomId: 'room-1', OR: [{ guestSessionId: 'session-1' }] },
      select: { id: true },
    });
    expect(tx.roomPlayer.create).not.toHaveBeenCalled();
    expect(tx.roomPlayer.update).not.toHaveBeenCalled();
  });

  it('rejects a banned user identity even when no password is set', async () => {
    const openRoom = room({ settings: { maxPlayers: 8 } });
    const { service } = makeService(openRoom, { id: 'ban-2' });
    await expect(service.joinRoom('ABC123', 'Alice', null, 'user-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
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

  it('retries a Serializable P2034 conflict and succeeds on the next attempt', async () => {
    const openRoom = room({ settings: { maxPlayers: 8 } });
    const { tx } = makeService(openRoom);
    const conflict = Object.assign(new Error('write conflict'), { code: 'P2034' });
    const transactional = jest
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementation(fn => fn(tx));
    tx.roomPlayer.create.mockResolvedValue({ id: 'player-new' });
    const service = new RoomService({ $transaction: transactional } as any);

    await expect(
      service.joinRoom('ABC123', 'New', 'session-new', null),
    ).resolves.toEqual({ roomId: 'room-1', roomCode: 'ABC123', playerId: 'player-new' });

    expect(transactional).toHaveBeenCalledTimes(2);
    expect(tx.roomPlayer.create).toHaveBeenCalledTimes(1);
  });

  it('bounds retries and rethrows after repeated P2034 conflicts', async () => {
    const conflict = Object.assign(new Error('write conflict'), {
      code: 'P2034',
    });
    const transactional = jest.fn().mockRejectedValue(conflict);
    const service = new RoomService({ $transaction: transactional } as any);

    await expect(
      service.joinRoom('ABC123', 'New', 'session-new', null),
    ).rejects.toMatchObject({ code: 'P2034' });
    expect(transactional).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-conflict errors', async () => {
    const transactional = jest.fn().mockRejectedValue(new Error('connection lost'));
    const service = new RoomService({ $transaction: transactional } as any);

    await expect(
      service.joinRoom('ABC123', 'New', 'session-new', null),
    ).rejects.toThrow('connection lost');
    expect(transactional).toHaveBeenCalledTimes(1);
  });
});

describe('RoomService.leaveRoom', () => {
  const makeTx = () => ({
    roomPlayer: {
      update: jest.fn().mockResolvedValue({ id: 'player-1' }),
      count: jest.fn().mockResolvedValue(0),
    },
    room: { update: jest.fn().mockResolvedValue({ id: 'room-1' }) },
  });

  it('commits the leftAt update, recount and empty-room reset in one transaction', async () => {
    const tx = makeTx();
    const prisma = { $transaction: jest.fn(fn => fn(tx)) } as any;
    const service = new RoomService(prisma);

    await expect(service.leaveRoom('room-1', 'player-1')).resolves.toEqual({ activeCount: 0 });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.roomPlayer.update).toHaveBeenCalledWith({
      where: { id: 'player-1', roomId: 'room-1' },
      data: { leftAt: expect.any(Date) },
    });
    expect(tx.roomPlayer.count).toHaveBeenCalledWith({ where: { roomId: 'room-1', leftAt: null } });
    expect(tx.room.update).toHaveBeenCalledWith({
      where: { id: 'room-1' },
      data: { status: 'WAITING', hostPlayerId: null },
    });
  });

  it('rolls back all writes when any step rejects', async () => {
    const tx = makeTx();
    tx.room.update.mockRejectedValue(new Error('db down'));
    // Simulate Prisma's transactional rollback by rejecting the whole callback.
    const prisma = {
      $transaction: jest.fn(async fn => {
        try {
          return await fn(tx);
        } catch (err) {
          throw err;
        }
      }),
    } as any;
    const service = new RoomService(prisma);

    await expect(service.leaveRoom('room-1', 'player-1')).rejects.toThrow('db down');
    expect(tx.roomPlayer.update).toHaveBeenCalledTimes(1);
    expect(tx.room.update).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('retries a P2034 conflict for leaveRoom', async () => {
    const tx = makeTx();
    const conflict = Object.assign(new Error('write conflict'), { code: 'P2034' });
    const transactional = jest
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementation(fn => fn(tx));
    const service = new RoomService({ $transaction: transactional } as any);

    await expect(service.leaveRoom('room-1', 'player-1')).resolves.toEqual({ activeCount: 0 });
    expect(transactional).toHaveBeenCalledTimes(2);
  });
});
