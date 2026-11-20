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
    addPlayer: jest.fn().mockReturnValue({ isHost: false, isReady: false, isOnline: true, score: 0 }),
    removePlayer: jest.fn(),
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
