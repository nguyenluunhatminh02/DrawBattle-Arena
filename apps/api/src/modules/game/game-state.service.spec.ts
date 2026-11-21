import { GameStateService, RoomEvent } from './game-state.service';

function makeService(): GameStateService {
  // addPlayer/initRoom are pure in-memory operations and do not use these
  // collaborators, so lightweight stubs keep this regression test focused.
  return new GameStateService({} as never, {} as never, {} as never, {} as never);
}

describe('GameStateService.addPlayer', () => {
  it('allows an existing player to reconnect when the room is full', () => {
    const service = makeService();
    service.initRoom('room-1', 'host', 'Host', {
      mode: 'CLASSIC',
      maxPlayers: 2,
      rounds: 1,
      turnDuration: 60,
      difficulty: 'MIXED',
      enableHints: true,
    } as never);

    expect(service.addPlayer('room-1', 'guest', 'Guest')).not.toBeNull();
    expect(service.addPlayer('room-1', 'third', 'Third')).toBeNull();

    const reconnected = service.addPlayer('room-1', 'guest', 'Guest');
    expect(reconnected).not.toBeNull();
    expect(reconnected?.id).toBe('guest');
    expect(reconnected?.isOnline).toBe(true);
  });
});

describe('GameStateService replay queueing', () => {
  const roomId = 'room-queue';
  const matchId = 'match-queue';
  const now = Date.now();

  let service: GameStateService;
  let events: RoomEvent[];
  let queueReplay: jest.Mock;
  let matchCreate: jest.Mock;

  const setupRoom = () => {
    service.initRoom(roomId, 'host', 'Host', {
      mode: 'CLASSIC',
      maxPlayers: 4,
      rounds: 1,
      turnDuration: 60,
      difficulty: 'MIXED',
      enableHints: false,
    } as never);
    service.addPlayer(roomId, 'guest', 'Guest');
    events = [];
    service.registerSink(roomId, event => events.push(event));
    const room = (service as unknown as { rooms: Map<string, { match: unknown }> }).rooms.get(roomId)!;
    room.match = {
      id: matchId,
      rounds: 1,
      totalTurns: 2,
      currentRound: 1,
      drawerOrder: ['host', 'guest'],
      currentDrawerIndex: 0,
      turn: null,
      completedTurns: [
        {
          id: 'turn-1',
          drawerId: 'host',
          wordId: 'word-1',
          strokes: [],
          startedAt: now,
          endsAt: now + 1000,
          correctCount: 0,
          guesses: [],
        },
        {
          id: 'turn-2',
          drawerId: 'guest',
          wordId: 'word-2',
          strokes: [],
          startedAt: now,
          endsAt: now + 1000,
          correctCount: 0,
          guesses: [],
        },
      ],
      startedAt: now - 2000,
    };
  };

  beforeEach(() => {
    queueReplay = jest.fn().mockResolvedValue({ jobId: 'job-1', status: 'queued' });
    matchCreate = jest.fn().mockResolvedValue({
      id: matchId,
      rounds: [
        {
          turns: [
            { replay: { id: 'replay-1' } },
            { replay: { id: 'replay-2' } },
          ],
        },
      ],
    });
    const prisma = {
      match: { create: matchCreate },
      room: { update: jest.fn().mockResolvedValue({}) },
    };
    service = new GameStateService(
      {} as never,
      prisma as never,
      {} as never,
      { queueReplay } as never,
    );
    setupRoom();
  });

  it('queues each persisted replay exactly once, even if endMatch runs twice', async () => {
    await (service as unknown as { endMatch: (roomId: string) => Promise<void> }).endMatch(roomId);

    expect(matchCreate).toHaveBeenCalledTimes(1);
    expect(queueReplay).toHaveBeenCalledTimes(2);
    expect(queueReplay).toHaveBeenNthCalledWith(1, 'replay-1');
    expect(queueReplay).toHaveBeenNthCalledWith(2, 'replay-2');

    await (service as unknown as { endMatch: (roomId: string) => Promise<void> }).endMatch(roomId);

    expect(matchCreate).toHaveBeenCalledTimes(1);
    expect(queueReplay).toHaveBeenCalledTimes(2);
    expect(events.find(event => event.type === 'match:finished')?.payload).toMatchObject({
      matchId,
      persisted: true,
    });
  });

  it('does not queue replays and reports persisted:false when match persistence fails', async () => {
    matchCreate.mockRejectedValueOnce(new Error('database down'));

    await (service as unknown as { endMatch: (roomId: string) => Promise<void> }).endMatch(roomId);

    expect(queueReplay).not.toHaveBeenCalled();
    expect(events.find(event => event.type === 'match:finished')?.payload).toMatchObject({
      matchId,
      persisted: false,
    });
  });
});

describe('GameStateService room status persistence', () => {
  const roomId = 'room-status';
  let service: GameStateService;
  let roomUpdate: jest.Mock;

  const setup = () => {
    roomUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      room: { update: roomUpdate },
      match: { create: jest.fn() },
    };
    service = new GameStateService(
      {
        pickRandomWords: jest.fn().mockResolvedValue([
          { id: 'word-1', canonical: 'mèo', difficulty: 'EASY', category: 'animals' },
        ]),
        getWordById: jest.fn().mockResolvedValue({ canonical: 'mèo', synonyms: [] }),
      } as never,
      prisma as never,
      { find: jest.fn().mockResolvedValue(null) } as never,
    );
    service.initRoom(roomId, 'host', 'Host', {
      mode: 'CLASSIC',
      maxPlayers: 2,
      rounds: 1,
      turnDuration: 60,
      difficulty: 'MIXED',
      enableHints: false,
    } as never);
    service.addPlayer(roomId, 'guest', 'Guest');
    service.setReady(roomId, 'guest', true);
    service.registerSink(roomId, () => undefined);
  };

  beforeEach(setup);

  afterEach(() => {
    const turn = (service as any).rooms.get(roomId)?.match?.turn;
    if (turn?.timer) clearTimeout(turn.timer);
    for (const t of turn?.hintTimers ?? []) clearTimeout(t);
  });

  it('awaits the PLAYING status write before startMatch resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    roomUpdate.mockImplementationOnce(() => gate.then(() => ({})));

    let started = false;
    const pending = service.startMatch(roomId).then(result => {
      started = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(false);
    expect(roomUpdate).toHaveBeenCalledWith({
      where: { id: roomId },
      data: { status: 'PLAYING' },
    });

    release();
    await expect(pending).resolves.toBe(true);
    expect(started).toBe(true);
  });

  it('retries P2034 status conflicts with a bound', async () => {
    const conflict = Object.assign(new Error('write conflict'), { code: 'P2034' });
    roomUpdate.mockRejectedValueOnce(conflict).mockRejectedValueOnce(conflict).mockResolvedValue({});

    await expect(service.startMatch(roomId)).resolves.toBe(true);
    expect(roomUpdate).toHaveBeenCalledTimes(3);
  });

  it('gives up after bounded P2034 conflicts and rolls back in-memory match state', async () => {
    const conflict = Object.assign(new Error('write conflict'), { code: 'P2034' });
    roomUpdate.mockRejectedValue(conflict);
    const errors: unknown[][] = [];
    const originalError = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation((...args: unknown[]) => errors.push(args));

    await expect(service.startMatch(roomId)).resolves.toBe(false);
    expect(roomUpdate).toHaveBeenCalledTimes(3);
    expect((service as any).rooms.get(roomId).match).toBeNull();
    expect(errors.some(args => String(args[0]).includes('Failed to persist room'))).toBe(true);
    originalError.mockRestore();
  });

  it('does not retry non-conflict status write errors', async () => {
    roomUpdate.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    await expect(service.startMatch(roomId)).resolves.toBe(false);
    expect(roomUpdate).toHaveBeenCalledTimes(1);
  });
});
