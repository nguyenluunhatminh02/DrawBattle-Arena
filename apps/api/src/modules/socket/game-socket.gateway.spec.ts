import { ForbiddenException } from '@nestjs/common';
import { GameSocketGateway } from './game-socket.gateway';

type SocketData = {
  identityType?: 'guest' | 'user';
  sessionId?: string;
  userId?: string;
  nickname?: string;
  playerId?: string;
  roomId?: string;
  roomCode?: string;
};

function makeSocket(id: string, data: SocketData = {}) {
  return {
    id,
    data: { ...data },
    rooms: new Set<string>(),
    emit: jest.fn(),
    join: jest.fn(function (this: any, room: string) {
      this.rooms.add(room);
    }),
    leave: jest.fn(function (this: any, room: string) {
      this.rooms.delete(room);
    }),
    disconnect: jest.fn(),
    handshake: { auth: {}, headers: {} },
  } as any;
}

function makeGateway() {
  const auth = {
    validateGuestToken: jest.fn(),
    validateUserToken: jest.fn(),
  };
  const roomService = {
    getRoomInfo: jest.fn().mockResolvedValue({ id: 'room-1', code: 'ABC123' }),
    joinRoom: jest.fn().mockResolvedValue({ roomId: 'room-1', roomCode: 'ABC123', playerId: 'p1' }),
    banPlayer: jest.fn().mockResolvedValue({ userId: null, guestSessionId: 'guest-1' }),
    leaveRoom: jest.fn().mockResolvedValue(undefined),
  };
  const game = {
    setPlayerOnline: jest.fn(),
    getSnapshot: jest.fn().mockReturnValue({
      players: [
        { id: 'host', isHost: true },
        { id: 'p1', isHost: false },
      ],
    }),
    getTurnSnapshot: jest.fn().mockReturnValue(null),
    getDrawerWord: jest.fn().mockReturnValue(null),
    initRoom: jest.fn(),
    registerSink: jest.fn(),
    addPlayer: jest.fn().mockReturnValue({ isHost: false, isReady: false, isOnline: true, score: 0 }),
    joinRoom: jest.fn(),
    removePlayer: jest.fn(),
    setReady: jest.fn(),
    isHost: jest.fn().mockImplementation((_room, player) => player === 'host'),
    kickPlayer: jest.fn().mockReturnValue(true),
    updateSettings: jest.fn(),
  };
  const redisAdapter = { configureAdapter: jest.fn() };
  const server = { to: jest.fn().mockReturnValue({ emit: jest.fn() }) };
  const gateway = new GameSocketGateway(auth as any, roomService as any, game as any, redisAdapter as any);
  gateway.server = server as any;
  return { gateway, auth, roomService, game, server };
}

describe('GameSocketGateway kick and disconnect timers', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function makeHostSocket(gateway: GameSocketGateway) {
    const socket = makeSocket('host-socket', {
      identityType: 'user',
      userId: 'host-user',
      sessionId: 'host-user',
      nickname: 'Host',
      playerId: 'host',
      roomId: 'room-1',
      roomCode: 'ABC123',
    });
    socket.rooms.add('room-1');
    (gateway as any).roomSockets.set('room-1', new Map([['host', socket], ['p1', makeSocket('target-socket')]]));
    return socket;
  }

  it('persists the ban before mutating the in-memory room or emitting a kick', async () => {
    const { gateway, roomService, game } = makeGateway();
    const socket = makeHostSocket(gateway);
    const events: string[] = [];
    roomService.banPlayer.mockImplementation(async () => {
      expect(game.kickPlayer).not.toHaveBeenCalled();
      expect((gateway as any).roomSockets.get('room-1').has('p1')).toBe(true);
      events.push('ban');
      return { userId: null, guestSessionId: 'guest-1' };
    });
    game.kickPlayer.mockImplementation(() => {
      events.push('kick');
      return true;
    });

    await gateway.onHostAction(socket, { action: 'kick', targetId: 'p1' });

    expect(events).toEqual(['ban', 'kick']);
    expect((gateway as any).roomSockets.get('room-1').has('p1')).toBe(false);
  });

  it('does not kick when the ban cannot be persisted', async () => {
    const { gateway, roomService, game } = makeGateway();
    const socket = makeHostSocket(gateway);
    roomService.banPlayer.mockRejectedValue(new Error('db down'));

    await gateway.onHostAction(socket, { action: 'kick', targetId: 'p1' });

    expect(game.kickPlayer).not.toHaveBeenCalled();
    expect((gateway as any).roomSockets.get('room-1').has('p1')).toBe(true);
    expect(socket.emit).toHaveBeenCalledWith('error', 'KICK_FAILED', 'Failed to persist kick');
  });

  it('does not create a ban for an unauthorized kick target', async () => {
    const { gateway, roomService, game } = makeGateway();
    const socket = makeHostSocket(gateway);
    game.getSnapshot.mockReturnValue({ players: [{ id: 'host', isHost: true }] });

    await gateway.onHostAction(socket, { action: 'kick', targetId: 'missing' });

    expect(roomService.banPlayer).not.toHaveBeenCalled();
    expect(game.kickPlayer).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', 'KICK_FAILED', 'Cannot kick player');
  });

  it('keeps the live socket timer when a stale duplicate socket disconnects', async () => {
    const { gateway } = makeGateway();
    const live = makeSocket('live-socket', { playerId: 'p1', roomId: 'room-1', sessionId: 's1' });
    const stale = makeSocket('stale-socket', { playerId: 'p1', roomId: 'room-1', sessionId: 's1' });
    (gateway as any).roomSockets.set('room-1', new Map([['p1', live]]));
    gateway.handleDisconnect(live);
    const liveTimer = (gateway as any).disconnectTimers.get('p1');

    gateway.handleDisconnect(stale);

    expect((gateway as any).disconnectTimers.get('p1')).toBe(liveTimer);
  });

  it('does not clear a matching-player timer recorded for another room', () => {
    const { gateway } = makeGateway();
    const socket = makeSocket('live-socket', { playerId: 'p1', roomId: 'room-1' });
    (gateway as any).roomSockets.set('room-1', new Map([['p1', socket]]));
    gateway.handleDisconnect(socket);
    const timer = (gateway as any).disconnectTimers.get('p1');

    expect((gateway as any).clearDisconnectTimer('other-room', 'p1')).toBe(false);
    expect((gateway as any).disconnectTimers.get('p1')).toBe(timer);
    expect((gateway as any).clearDisconnectTimer('room-1', 'p1')).toBe(true);
    expect((gateway as any).disconnectTimers.has('p1')).toBe(false);
  });
});

describe('GameSocketGateway single-room membership and socket replacement', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function authedData(sessionId: string) {
    return {
      identityType: 'guest' as const,
      sessionId,
      nickname: 'Player',
    };
  }

  it('leaves the previous room (DB, in-memory state, Socket.IO) when joining a new room', async () => {
    const { gateway, roomService, game } = makeGateway();
    const socket = makeSocket('s1', authedData('guest-1'));
    // Seed membership in room A.
    (gateway as any).roomSockets.set('room-1', new Map([['p1', socket]]));
    socket.data.playerId = 'p1';
    socket.data.roomId = 'room-1';
    socket.data.roomCode = 'AAA111';
    socket.join('room-1');

    // Target room B.
    roomService.getRoomInfo.mockResolvedValue({ id: 'room-2', code: 'BBB222' });
    roomService.joinRoom.mockResolvedValue({ roomId: 'room-2', roomCode: 'BBB222', playerId: 'p2' });

    await gateway.onRoomJoin(socket, { roomCode: 'BBB222' });

    // Room A membership must be fully released.
    expect(roomService.leaveRoom).toHaveBeenCalledWith('room-1', 'p1');
    expect(game.removePlayer).toHaveBeenCalledWith('room-1', 'p1');
    expect(socket.rooms.has('room-1')).toBe(false);
    expect((gateway as any).roomSockets.has('room-1')).toBe(false);

    // Room B membership must be installed.
    expect(socket.rooms.has('room-2')).toBe(true);
    expect((gateway as any).roomSockets.get('room-2').get('p2')).toBe(socket);
    expect(socket.data.roomId).toBe('room-2');
    expect(socket.data.playerId).toBe('p2');
  });

  it('aborts a room switch when the old room leave cannot be persisted', async () => {
    const { gateway, roomService, game } = makeGateway();
    const socket = makeSocket('s1', authedData('guest-1'));
    (gateway as any).roomSockets.set('room-1', new Map([['p1', socket]]));
    socket.data.playerId = 'p1';
    socket.data.roomId = 'room-1';
    socket.data.roomCode = 'AAA111';
    socket.join('room-1');

    roomService.getRoomInfo.mockResolvedValue({ id: 'room-2', code: 'BBB222' });
    roomService.leaveRoom.mockImplementation(async (roomId: string) => {
      if (roomId === 'room-1') throw new Error('db down');
    });

    await gateway.onRoomJoin(socket, { roomCode: 'BBB222' });

    // Old membership and socket state remain intact.
    expect(game.removePlayer).not.toHaveBeenCalled();
    expect(socket.rooms.has('room-1')).toBe(true);
    expect((gateway as any).roomSockets.get('room-1').get('p1')).toBe(socket);
    expect(socket.data.roomId).toBe('room-1');
    expect(socket.data.playerId).toBe('p1');

    // Destination is never written or installed.
    expect(roomService.joinRoom).not.toHaveBeenCalled();
    expect(game.addPlayer).not.toHaveBeenCalledWith('room-2', 'p2', expect.anything());
    expect(socket.rooms.has('room-2')).toBe(false);
    expect(socket.emit).toHaveBeenCalledWith('error', 'SWITCH_FAILED', 'Could not leave the previous room');
  });

  it('revokes the old socket and blocks its actions after a new socket replaces it', async () => {
    const { gateway, game } = makeGateway();
    const oldSocket = makeSocket('old-socket', {
      ...authedData('guest-1'),
      playerId: 'p1',
      roomId: 'room-1',
      roomCode: 'AAA111',
    });
    oldSocket.join('room-1');
    (gateway as any).roomSockets.set('room-1', new Map([['p1', oldSocket]]));

    const newSocket = makeSocket('new-socket', authedData('guest-1'));

    await gateway.onRoomJoin(newSocket, { roomCode: 'ABC123' });

    // Old socket is revoked, new socket is the active member.
    expect(oldSocket.emit).toHaveBeenCalledWith('session:replaced', { roomId: 'room-1' });
    expect(oldSocket.rooms.has('room-1')).toBe(false);
    expect(oldSocket.data.roomId).toBeUndefined();
    expect(oldSocket.data.playerId).toBeUndefined();
    expect((gateway as any).roomSockets.get('room-1').get('p1')).toBe(newSocket);

    // The old socket can no longer perform room-scoped actions.
    gateway.onReady(oldSocket, true);
    expect(game.setReady).not.toHaveBeenCalled();
  });

  it('ignores a stale socket disconnect after a newer socket took over', async () => {
    const { gateway, roomService, game } = makeGateway();
    const oldSocket = makeSocket('old-socket', {
      ...authedData('guest-1'),
      playerId: 'p1',
      roomId: 'room-1',
      roomCode: 'AAA111',
    });
    oldSocket.join('room-1');
    (gateway as any).roomSockets.set('room-1', new Map([['p1', oldSocket]]));

    const newSocket = makeSocket('new-socket', authedData('guest-1'));
    await gateway.onRoomJoin(newSocket, { roomCode: 'ABC123' });

    gateway.handleDisconnect(oldSocket);

    // The live socket remains registered and online.
    expect((gateway as any).roomSockets.get('room-1').get('p1')).toBe(newSocket);
    expect(game.setPlayerOnline).not.toHaveBeenCalledWith('room-1', 'p1', false);
    expect(roomService.leaveRoom).not.toHaveBeenCalled();
  });
});

describe('GameSocketGateway ready state validation', () => {
  it('ignores ready events from a stale socket that still carries room data', () => {
    const { gateway, game } = makeGateway();
    const live = makeSocket('live-socket', { playerId: 'p1', roomId: 'room-1' });
    const stale = makeSocket('stale-socket', { playerId: 'p1', roomId: 'room-1' });
    live.join('room-1');
    stale.join('room-1');
    (gateway as any).roomSockets.set('room-1', new Map([['p1', live]]));

    gateway.onReady(stale, true);

    expect(game.setReady).not.toHaveBeenCalled();
    expect(stale.emit).not.toHaveBeenCalledWith('error', expect.anything(), expect.anything());
  });

  it('rejects non-boolean ready payloads without mutating game state', () => {
    const { gateway, game } = makeGateway();
    const socket = makeSocket('s1', { playerId: 'p1', roomId: 'room-1' });
    socket.join('room-1');
    (gateway as any).roomSockets.set('room-1', new Map([['p1', socket]]));

    gateway.onReady(socket, 'true' as any);

    expect(game.setReady).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', 'INVALID_PAYLOAD', 'Invalid ready state');
  });

  it('accepts boolean ready payloads from the active member', () => {
    const { gateway, game } = makeGateway();
    const socket = makeSocket('s1', { playerId: 'p1', roomId: 'room-1' });
    socket.join('room-1');
    (gateway as any).roomSockets.set('room-1', new Map([['p1', socket]]));

    gateway.onReady(socket, true);

    expect(game.setReady).toHaveBeenCalledWith('room-1', 'p1', true);
    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything(), expect.anything());
  });
});

describe('GameSocketGateway room join error sanitation', () => {
  it('never forwards internal error details to the socket client', async () => {
    const { gateway, roomService } = makeGateway();
    const socket = makeSocket('s1', {
      identityType: 'guest',
      sessionId: 'guest-1',
      nickname: 'Player',
    });
    const secret = 'prisma://user:secret123@db.internal:5432/rooms?schema=internal';
    roomService.joinRoom.mockRejectedValueOnce(new Error(`duplicate key: ${secret}`));

    await gateway.onRoomJoin(socket, { roomCode: 'ABC123' });

    const errorCall = socket.emit.mock.calls.find((call: unknown[]) => call[0] === 'error');
    expect(errorCall).toBeDefined();
    expect(errorCall![1]).toBe('JOIN_FAILED');
    expect(errorCall![2]).toBe('Could not join room');
    expect(JSON.stringify(errorCall)).not.toContain('password');
    expect(JSON.stringify(errorCall)).not.toContain('db.internal');
  });

  it('maps a kicked error to a fixed client-safe code and message', async () => {
    const { gateway, roomService } = makeGateway();
    const socket = makeSocket('s1', {
      identityType: 'guest',
      sessionId: 'guest-1',
      nickname: 'Player',
    });
    roomService.joinRoom.mockRejectedValueOnce(
      new ForbiddenException('You were kicked from this room; internal id 42'),
    );

    await gateway.onRoomJoin(socket, { roomCode: 'ABC123' });

    expect(socket.emit).toHaveBeenCalledWith('error', 'KICKED', 'You were kicked from this room');
  });
});
