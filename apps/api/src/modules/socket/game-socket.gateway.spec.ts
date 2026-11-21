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
    getRoomById: jest.fn().mockResolvedValue({
      id: 'room-1',
      status: 'WAITING',
      hostPlayerId: 'host',
      settings: { maxPlayers: 8 },
      players: [{ id: 'host', nicknameSnapshot: 'Host' }, { id: 'p1', nicknameSnapshot: 'Player' }],
    }),
    resetRoomStatus: jest.fn().mockResolvedValue(undefined),
    updateHost: jest.fn().mockResolvedValue(undefined),
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

  it('keeps a reload join when the old socket leaves and its grace timer fires mid-join', async () => {
    const { gateway, roomService, game } = makeGateway();
    const oldSocket = makeSocket('old-socket', {
      ...authedData('guest-1'), playerId: 'p1', roomId: 'room-1', roomCode: 'ABC123',
    });
    oldSocket.join('room-1');
    (gateway as any).roomSockets.set('room-1', new Map([['p1', oldSocket]]));
    (gateway as any).activeMemberships.set('room-1\u0000p1', { generation: 1, socketId: oldSocket.id });
    gateway.handleDisconnect(oldSocket);
    const oldTimer = (gateway as any).disconnectTimers.get('p1');
    expect(oldTimer).toBeDefined();
    expect((gateway as any).roomSockets.has('room-1')).toBe(false);

    const newSocket = makeSocket('new-socket', authedData('guest-1'));
    let resolveJoin!: (value: { roomId: string; roomCode: string; playerId: string }) => void;
    let joinRequested!: () => void;
    const requestSeen = new Promise<void>(resolve => { joinRequested = resolve; });
    roomService.joinRoom.mockImplementation(() => {
      joinRequested();
      return new Promise(resolve => { resolveJoin = resolve; });
    });
    const joinPromise = gateway.onRoomJoin(newSocket, { roomCode: 'ABC123' });
    await requestSeen;
    resolveJoin({ roomId: 'room-1', roomCode: 'ABC123', playerId: 'p1' });
    await joinPromise;

    expect((gateway as any).disconnectTimers.has('p1')).toBe(false);
    expect((gateway as any).roomSockets.get('room-1').get('p1')).toBe(newSocket);
    expect(roomService.leaveRoom).not.toHaveBeenCalled();
    expect(newSocket.emit).toHaveBeenCalledWith('room:snapshot', expect.objectContaining({ yourPlayerId: 'p1' }));

    // Even if an already queued stale timer callback still runs, it must not
    // evict the player whose socket is now active.
    await jest.advanceTimersByTimeAsync(15_000);
    expect((gateway as any).roomSockets.get('room-1').get('p1')).toBe(newSocket);
    expect(game.removePlayer).not.toHaveBeenCalled();
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

describe('GameSocketGateway room switch failure recovery', () => {
  function authedData(sessionId: string) {
    return {
      identityType: 'guest' as const,
      sessionId,
      nickname: 'Player',
    };
  }

  function seedOldRoom(gateway: GameSocketGateway, socket: any) {
    (gateway as any).roomSockets.set('room-1', new Map([['p1', socket]]));
    (gateway as any).activeMemberships.set('room-1\u0000p1', { generation: 1, socketId: socket.id });
    socket.data.playerId = 'p1';
    socket.data.roomId = 'room-1';
    socket.data.roomCode = 'AAA111';
    socket.join('room-1');
  }

  it('restores the old room when the destination join fails after a successful leave', async () => {
    const { gateway, roomService, game } = makeGateway();
    const socket = makeSocket('s1', authedData('guest-1'));
    seedOldRoom(gateway, socket);
    roomService.getRoomInfo.mockResolvedValue({ id: 'room-2', code: 'BBB222' });
    roomService.joinRoom.mockRejectedValueOnce(new Error('db down')).mockResolvedValue({
      roomId: 'room-1', roomCode: 'AAA111', playerId: 'p1',
    });

    await gateway.onRoomJoin(socket, { roomCode: 'BBB222' });

    expect(roomService.leaveRoom).toHaveBeenCalledWith('room-1', 'p1');
    expect(roomService.joinRoom).toHaveBeenLastCalledWith(
      'AAA111', 'Player', 'guest-1', null,
    );
    expect(socket.data.roomId).toBe('room-1');
    expect(socket.data.playerId).toBe('p1');
    expect(socket.rooms.has('room-1')).toBe(true);
    expect((gateway as any).roomSockets.get('room-1').get('p1')).toBe(socket);
    expect(socket.emit).toHaveBeenCalledWith('error', 'JOIN_FAILED', 'Could not join room');
  });

  it('leaves no stale active membership when restoring the old room also fails', async () => {
    const { gateway, roomService, game } = makeGateway();
    const socket = makeSocket('s1', authedData('guest-1'));
    seedOldRoom(gateway, socket);
    roomService.getRoomInfo.mockResolvedValue({ id: 'room-2', code: 'BBB222' });
    roomService.joinRoom.mockRejectedValue(new Error('db down'));

    await gateway.onRoomJoin(socket, { roomCode: 'BBB222' });

    expect(socket.data.roomId).toBeUndefined();
    expect(socket.data.playerId).toBeUndefined();
    expect(socket.rooms.has('room-1')).toBe(false);
    expect((gateway as any).roomSockets.has('room-1')).toBe(false);
    expect((gateway as any).activeMemberships.has('room-1\u0000p1')).toBe(false);
    expect(socket.emit).toHaveBeenCalledWith('error', 'SWITCH_FAILED', 'Could not join room or restore the previous room');
  });

  it('does not evict a replacement socket registered during the leave await', async () => {
    const { gateway, roomService } = makeGateway();
    const oldSocket = makeSocket('old-socket', {
      ...authedData('guest-1'), playerId: 'p1', roomId: 'room-1', roomCode: 'AAA111',
    });
    oldSocket.join('room-1');
    (gateway as any).roomSockets.set('room-1', new Map([['p1', oldSocket]]));
    (gateway as any).activeMemberships.set('room-1\u0000p1', { generation: 1, socketId: oldSocket.id });
    const replacement = makeSocket('replacement-socket', authedData('guest-1'));

    // Register the replacement while the old socket's leave is in flight.
    roomService.leaveRoom.mockImplementation(async () => {
      (gateway as any).activeMemberships.set('room-1\u0000p1', { generation: 99, socketId: replacement.id });
      (gateway as any).roomSockets.get('room-1').set('p1', replacement);
      oldSocket.data.roomId = undefined;
      oldSocket.data.playerId = undefined;
    });

    await (gateway as any).leaveCurrentRoom(oldSocket);

    expect((gateway as any).activeMemberships.get('room-1\u0000p1').socketId).toBe(replacement.id);
    expect((gateway as any).roomSockets.get('room-1').get('p1')).toBe(replacement);
    expect(replacement.data.roomId).toBeUndefined();
  });

  it('rolls back the destination row when post-join setup fails', async () => {
    const { gateway, roomService, game } = makeGateway();
    const socket = makeSocket('s1', authedData('guest-1'));
    roomService.getRoomInfo.mockResolvedValue({ id: 'room-2', code: 'BBB222' });
    roomService.joinRoom.mockResolvedValue({ roomId: 'room-2', roomCode: 'BBB222', playerId: 'p2' });
    game.getSnapshot.mockReturnValue(null);
    roomService.getRoomById.mockRejectedValue(new Error('db down'));

    await gateway.onRoomJoin(socket, { roomCode: 'BBB222' });

    expect(roomService.leaveRoom).toHaveBeenCalledWith('room-2', 'p2');
    expect(socket.rooms.has('room-2')).toBe(false);
    expect((gateway as any).roomSockets.has('room-2')).toBe(false);
    expect((gateway as any).activeMemberships.has('room-2\u0000p2')).toBe(false);
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

  it.each([undefined, null])('rejects %s ready payloads before checking membership', payload => {
    const { gateway, game, server } = makeGateway();
    const stale = makeSocket('stale-socket', { playerId: 'p1', roomId: 'room-1' });

    gateway.onReady(stale, payload as any);

    expect(stale.emit).toHaveBeenCalledWith('error', 'INVALID_PAYLOAD', 'Invalid ready state');
    expect(game.setReady).not.toHaveBeenCalled();
    expect(server.to).not.toHaveBeenCalled();
  });

  it('does not broadcast room updates for stale ready events', () => {
    const { gateway, game, server } = makeGateway();
    const live = makeSocket('live-socket', { playerId: 'p1', roomId: 'room-1' });
    const stale = makeSocket('stale-socket', { playerId: 'p1', roomId: 'room-1' });
    live.join('room-1');
    stale.join('room-1');
    (gateway as any).roomSockets.set('room-1', new Map([['p1', live]]));

    gateway.onReady(stale, true);

    expect(game.setReady).not.toHaveBeenCalled();
    expect(server.to).not.toHaveBeenCalled();
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

describe('GameSocketGateway settings update errors', () => {
  function makeHostSocket(gateway: GameSocketGateway) {
    const socket = makeSocket('host-socket', {
      playerId: 'host',
      roomId: 'room-1',
      roomCode: 'ABC123',
    });
    socket.rooms.add('room-1');
    (gateway as any).roomSockets.set('room-1', new Map([['host', socket]]));
    return socket;
  }

  it('reports a distinct safe code when settings persistence fails', async () => {
    const { gateway, game } = makeGateway();
    const socket = makeHostSocket(gateway);
    game.updateSettings.mockResolvedValue({ ok: false, reason: 'SETTINGS_SAVE_FAILED' });

    await gateway.onUpdateSettings(socket, { rounds: 3 });

    expect(game.updateSettings).toHaveBeenCalledWith('room-1', 'host', { rounds: 3 });
    expect(socket.emit).toHaveBeenCalledWith('error', 'SETTINGS_SAVE_FAILED', 'Could not save settings');
    expect(socket.emit).not.toHaveBeenCalledWith('error', 'SETTINGS_FAILED', expect.anything());
  });

  it('keeps the match-in-progress error when the room is playing', async () => {
    const { gateway, game } = makeGateway();
    const socket = makeHostSocket(gateway);
    game.updateSettings.mockResolvedValue({ ok: false, reason: 'MATCH_IN_PROGRESS' });

    await gateway.onUpdateSettings(socket, { rounds: 3 });

    expect(socket.emit).toHaveBeenCalledWith('error', 'SETTINGS_FAILED', 'Cannot update settings during a match');
    expect(socket.emit).not.toHaveBeenCalledWith('error', 'SETTINGS_SAVE_FAILED', expect.anything());
  });

  it('does not report a recreated room as a match-in-progress failure', async () => {
    const { gateway, game } = makeGateway();
    const socket = makeHostSocket(gateway);
    game.updateSettings.mockResolvedValue({ ok: false, reason: 'ROOM_REPLACED' });

    await gateway.onUpdateSettings(socket, { rounds: 3 });

    expect(socket.emit).toHaveBeenCalledWith('error', 'SETTINGS_SAVE_FAILED', 'Could not save settings');
    expect(socket.emit).not.toHaveBeenCalledWith('error', 'SETTINGS_FAILED', expect.anything());
  });

  it('never forwards raw database error text to the client', async () => {
    const { gateway, game } = makeGateway();
    const socket = makeHostSocket(gateway);
    const secret = 'server=db.internal user=admin password=hunter2';
    game.updateSettings.mockResolvedValue({ ok: false, reason: 'SETTINGS_SAVE_FAILED', detail: secret });

    await gateway.onUpdateSettings(socket, { rounds: 3 });

    for (const call of (socket.emit as jest.Mock).mock.calls) {
      expect(JSON.stringify(call)).not.toContain(secret);
    }
    expect(socket.emit).toHaveBeenCalledWith('error', 'SETTINGS_SAVE_FAILED', 'Could not save settings');
  });

  it('emits a generic safe failure for non-match internal reasons', async () => {
    const { gateway, game } = makeGateway();
    const socket = makeHostSocket(gateway);
    game.updateSettings.mockResolvedValue({ ok: false, reason: 'ROOM_NOT_FOUND' });

    await gateway.onUpdateSettings(socket, { rounds: 3 });

    expect(socket.emit).toHaveBeenCalledWith('error', 'SETTINGS_SAVE_FAILED', 'Could not save settings');
  });

  it('does not emit an error when the settings update succeeds', async () => {
    const { gateway, game } = makeGateway();
    const socket = makeHostSocket(gateway);
    game.updateSettings.mockResolvedValue({ ok: true });

    await gateway.onUpdateSettings(socket, { rounds: 3 });

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

describe('GameSocketGateway join race conditions', () => {
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

  it('invalidates an older in-flight join when a newer join for the same slot commits first', async () => {
    const { gateway, roomService, game } = makeGateway();
    const socket1 = makeSocket('s1', authedData('guest-1'));
    const socket2 = makeSocket('s2', authedData('guest-1'));

    let resolveJoin1!: (value: { roomId: string; roomCode: string; playerId: string }) => void;
    let join1Requested!: () => void;
    const join1Seen = new Promise<void>(resolve => { join1Requested = resolve; });
    roomService.joinRoom.mockImplementationOnce(() => {
      join1Requested();
      return new Promise(resolve => { resolveJoin1 = resolve; });
    });

    const join1Promise = gateway.onRoomJoin(socket1, { roomCode: 'ABC123' });
    await join1Seen;

    // Socket2 starts a new join for the same slot while socket1 is still pending.
    let resolveJoin2!: (value: { roomId: string; roomCode: string; playerId: string }) => void;
    let join2Requested!: () => void;
    const join2Seen = new Promise<void>(resolve => { join2Requested = resolve; });
    roomService.joinRoom.mockImplementationOnce(() => {
      join2Requested();
      return new Promise(resolve => { resolveJoin2 = resolve; });
    });

    const join2Promise = gateway.onRoomJoin(socket2, { roomCode: 'ABC123' });
    await join2Seen;

    // Socket2 resolves first and commits.
    resolveJoin2({ roomId: 'room-1', roomCode: 'ABC123', playerId: 'p1' });
    await join2Promise;

    expect((gateway as any).roomSockets.get('room-1').get('p1')).toBe(socket2);

    // Socket1 resolves later but must not commit or roll back socket2's row.
    resolveJoin1({ roomId: 'room-1', roomCode: 'ABC123', playerId: 'p1' });
    await join1Promise;

    // Socket2 remains the active member.
    expect((gateway as any).roomSockets.get('room-1').get('p1')).toBe(socket2);
    expect(roomService.leaveRoom).not.toHaveBeenCalled();
    expect(game.removePlayer).not.toHaveBeenCalled();
  });

  it('aborts a join when the socket disconnects before the DB await resolves', async () => {
    const { gateway, roomService, game } = makeGateway();
    const socket = makeSocket('s1', authedData('guest-1'));

    let resolveJoin!: (value: { roomId: string; roomCode: string; playerId: string }) => void;
    let joinRequested!: () => void;
    const joinSeen = new Promise<void>(resolve => { joinRequested = resolve; });
    roomService.joinRoom.mockImplementation(() => {
      joinRequested();
      return new Promise(resolve => { resolveJoin = resolve; });
    });

    const joinPromise = gateway.onRoomJoin(socket, { roomCode: 'ABC123' });
    await joinSeen;

    // Socket disconnects while join is pending.
    gateway.handleDisconnect(socket);

    resolveJoin({ roomId: 'room-1', roomCode: 'ABC123', playerId: 'p1' });
    await joinPromise;

    // The join must not commit or install the socket. Its own DB row is rolled
    // back so no active row is left without a socket.
    expect((gateway as any).roomSockets.has('room-1')).toBe(false);
    expect(roomService.leaveRoom).toHaveBeenCalledWith('room-1', 'p1');
    expect(game.addPlayer).not.toHaveBeenCalled();
  });

  it('does not evict a newer socket when a disconnect timer fires while its join commits', async () => {
    const { gateway, roomService, game } = makeGateway();
    const oldSocket = makeSocket('old-socket', {
      ...authedData('guest-1'), playerId: 'p1', roomId: 'room-1', roomCode: 'ABC123',
    });
    oldSocket.join('room-1');
    (gateway as any).roomSockets.set('room-1', new Map([['p1', oldSocket]]));
    (gateway as any).activeMemberships.set('room-1\u0000p1', { generation: 1, socketId: oldSocket.id });

    // Old socket disconnects, starting a grace timer.
    gateway.handleDisconnect(oldSocket);
    const timer = (gateway as any).disconnectTimers.get('p1');
    expect(timer).toBeDefined();

    // New socket starts a join while the timer is pending.
    const newSocket = makeSocket('new-socket', authedData('guest-1'));
    let resolveJoin!: (value: { roomId: string; roomCode: string; playerId: string }) => void;
    let joinRequested!: () => void;
    const joinSeen = new Promise<void>(resolve => { joinRequested = resolve; });
    roomService.joinRoom.mockImplementation(() => {
      joinRequested();
      return new Promise(resolve => { resolveJoin = resolve; });
    });

    const joinPromise = gateway.onRoomJoin(newSocket, { roomCode: 'ABC123' });
    await joinSeen;

    // Timer fires while join is still pending, calling leaveRoom.
    let resolveLeave!: (value: undefined) => void;
    roomService.leaveRoom.mockImplementationOnce(() => {
      return new Promise<undefined>(resolve => { resolveLeave = resolve; });
    });
    await jest.advanceTimersByTimeAsync(15_000);

    // Join resolves and commits before the timer's leaveRoom completes.
    resolveJoin({ roomId: 'room-1', roomCode: 'ABC123', playerId: 'p1' });
    await joinPromise;

    expect((gateway as any).roomSockets.get('room-1').get('p1')).toBe(newSocket);

    // Timer's leaveRoom completes but must not evict the new socket.
    resolveLeave(undefined);
    await Promise.resolve();

    expect((gateway as any).roomSockets.get('room-1').get('p1')).toBe(newSocket);
    expect(game.removePlayer).not.toHaveBeenCalled();
  });

  it('does not roll back the winning socket row from an invalidated older attempt', async () => {
    const { gateway, roomService, game } = makeGateway();
    const socket1 = makeSocket('s1', authedData('guest-1'));
    const socket2 = makeSocket('s2', authedData('guest-1'));

    // Both joins target the same identity/slot, so the older attempt must be
    // invalidated as soon as the newer one registers its target.
    let resolveJoin1!: (value: { roomId: string; roomCode: string; playerId: string }) => void;
    let join1Requested!: () => void;
    const join1Seen = new Promise<void>(resolve => { join1Requested = resolve; });
    roomService.joinRoom.mockImplementationOnce(() => {
      join1Requested();
      return new Promise(resolve => { resolveJoin1 = resolve; });
    });
    const join1Promise = gateway.onRoomJoin(socket1, { roomCode: 'ABC123' });
    await join1Seen;

    let resolveJoin2!: (value: { roomId: string; roomCode: string; playerId: string }) => void;
    let join2Requested!: () => void;
    const join2Seen = new Promise<void>(resolve => { join2Requested = resolve; });
    roomService.joinRoom.mockImplementationOnce(() => {
      join2Requested();
      return new Promise(resolve => { resolveJoin2 = resolve; });
    });
    const join2Promise = gateway.onRoomJoin(socket2, { roomCode: 'ABC123' });
    await join2Seen;

    // The newer join commits first.
    resolveJoin2({ roomId: 'room-1', roomCode: 'ABC123', playerId: 'p1' });
    await join2Promise;

    // The older join resolves last and must neither commit nor roll back the
    // newer socket's DB row.
    resolveJoin1({ roomId: 'room-1', roomCode: 'ABC123', playerId: 'p1' });
    await join1Promise;

    expect((gateway as any).roomSockets.get('room-1').get('p1')).toBe(socket2);
    expect(roomService.leaveRoom).not.toHaveBeenCalled();
    expect(game.removePlayer).not.toHaveBeenCalled();
    expect(socket1.data.roomId).toBeUndefined();
    expect(socket2.data.roomId).toBe('room-1');
  });

  it('rolls back an invalidated attempt own row when no newer socket owns that slot', async () => {
    const { gateway, roomService, game } = makeGateway();
    const socket = makeSocket('s1', authedData('guest-1'));

    let resolveJoin!: (value: { roomId: string; roomCode: string; playerId: string }) => void;
    let joinRequested!: () => void;
    const joinSeen = new Promise<void>(resolve => { joinRequested = resolve; });
    roomService.joinRoom.mockImplementationOnce(() => {
      joinRequested();
      return new Promise(resolve => { resolveJoin = resolve; });
    });

    const joinPromise = gateway.onRoomJoin(socket, { roomCode: 'ABC123' });
    await joinSeen;

    // Invalidate this attempt while its DB join is in flight. It still owns
    // the row that is about to be created and must release that row itself.
    const generation = [...(gateway as any).joinAttemptStates.keys()][0];
    (gateway as any).invalidateJoinAttempt(generation);

    resolveJoin({ roomId: 'room-1', roomCode: 'ABC123', playerId: 'p1' });
    await joinPromise;

    expect(roomService.leaveRoom).toHaveBeenCalledWith('room-1', 'p1');
    expect(game.addPlayer).not.toHaveBeenCalledWith('room-1', 'p1', 'Player');
    expect((gateway as any).roomSockets.has('room-1')).toBe(false);
    expect((gateway as any).joinAttemptStates.size).toBe(0);
    expect((gateway as any).joinAttemptTargets.size).toBe(0);
  });

  it('cleans up stale join targets after an attempt ends', async () => {
    const { gateway, roomService } = makeGateway();
    const socket = makeSocket('s1', authedData('guest-1'));

    await gateway.onRoomJoin(socket, { roomCode: 'ABC123' });

    // After the join completes, no stale targets should remain.
    expect((gateway as any).joinAttemptTargets.size).toBe(0);
    expect((gateway as any).joinAttemptStates.size).toBe(0);
    expect((gateway as any).joinAttempts.size).toBe(0);
  });
});
