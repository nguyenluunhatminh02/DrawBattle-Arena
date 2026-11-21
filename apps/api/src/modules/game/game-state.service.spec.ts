import {
  GameStateService,
  isSettingsUpdateFailure,
  RoomEvent,
  SettingsUpdateResult,
} from './game-state.service';

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

describe('GameStateService status generation fencing', () => {
  const roomId = 'room-generation';

  it('keeps a pending WAITING write stale across a room recreation', async () => {
    const roomUpdate = jest.fn().mockResolvedValue({});
    const service = new GameStateService(
      {} as never,
      { room: { update: roomUpdate }, match: { create: jest.fn() } } as never,
      {} as never,
    );
    const settings = {
      mode: 'CLASSIC',
      maxPlayers: 2,
      rounds: 1,
      turnDuration: 60,
      difficulty: 'MIXED',
      enableHints: false,
    } as never;
    const writeStatus = (status: 'PLAYING' | 'WAITING') =>
      (service as any).writeRoomStatus(roomId, status) as Promise<void>;

    // Last player leaves: the room is removed and a WAITING write is queued.
    service.initRoom(roomId, 'host', 'Host', settings);
    writeStatus('PLAYING');
    service.removePlayer(roomId, 'host');
    expect((service as any).rooms.has(roomId)).toBe(false);
    expect(roomUpdate).not.toHaveBeenCalled();

    // A new lifetime must not reset the generation, otherwise the queued
    // WAITING write would pass isCurrent() and corrupt the new room's status.
    service.initRoom(roomId, 'newHost', 'New Host', settings);
    const freshStart = writeStatus('PLAYING');
    await freshStart;
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(roomUpdate).toHaveBeenCalledTimes(1);
    expect(roomUpdate).toHaveBeenCalledWith({
      where: { id: roomId },
      data: { status: 'PLAYING' },
    });
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
  let pickRandomWords: jest.Mock;
  let flags: { find: jest.Mock };

  const setup = () => {
    roomUpdate = jest.fn().mockResolvedValue({});
    pickRandomWords = jest.fn().mockResolvedValue([
      { id: 'word-1', canonical: 'mèo', difficulty: 'EASY', category: 'animals' },
    ]);
    flags = { find: jest.fn().mockResolvedValue(null) };
    const prisma = {
      room: { update: roomUpdate },
      match: { create: jest.fn() },
    };
    service = new GameStateService(
      {
        pickRandomWords,
        getWordById: jest.fn().mockResolvedValue({ canonical: 'mèo', synonyms: [] }),
        incrementUsage: jest.fn().mockResolvedValue(undefined),
      } as never,
      prisma as never,
      flags as never,
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
    // clear the room entirely so no delayed word-pick timer can fire after
    // the test (those callbacks would call collaborators absent from stubs).
    (service as any).rooms.delete(roomId);
  });

  // writeRoomStatus chains on previous writes, so dispatch happens a few
  // microtasks later; a macrotask flush makes the assertions deterministic.
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));

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
    await flush();
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
    roomUpdate
      .mockImplementationOnce(() => Promise.reject(conflict))
      .mockImplementationOnce(() => Promise.reject(conflict))
      .mockResolvedValue({});

    const started = service.startMatch(roomId);
    await expect(started).resolves.toBe(true);
    expect(roomUpdate).toHaveBeenCalledTimes(3);
  });

  it('gives up after bounded P2034 conflicts and rolls back in-memory match state', async () => {
    const conflict = Object.assign(new Error('write conflict'), { code: 'P2034' });
    roomUpdate.mockRejectedValue(conflict);
    const errors: unknown[][] = [];
    const originalError = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation((...args: unknown[]) => errors.push(args));

    const started = service.startMatch(roomId);
    await expect(started).resolves.toBe(false);
    expect(roomUpdate).toHaveBeenCalledTimes(3);
    expect((service as any).rooms.get(roomId).match).toBeNull();
    expect(errors.some(args => String(args[0]).includes('Failed to persist room'))).toBe(true);
    originalError.mockRestore();
  });

  it('does not retry non-conflict status write errors', async () => {
    roomUpdate.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    const started = service.startMatch(roomId);
    await expect(started).resolves.toBe(false);
    expect(roomUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not write PLAYING when word prefetch fails during init', async () => {
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    pickRandomWords.mockRejectedValueOnce(new Error('word service down'));

    await expect(service.startMatch(roomId)).resolves.toBe(false);
    expect(roomUpdate).not.toHaveBeenCalled();
    expect((service as any).rooms.get(roomId).match).toBeNull();
  });

  it('rolls back to WAITING when word pick setup fails after PLAYING was persisted', async () => {
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    // Fail only during the post-PLAYING word pick phase (match:started must
    // still be emitted so that the compensation path is the one under test).
    service.registerSink(roomId, (event: RoomEvent) => {
      if (event.type === 'turn:youAreDrawer') throw new Error('sink down');
    });

    await expect(service.startMatch(roomId)).resolves.toBe(false);
    expect(roomUpdate).toHaveBeenNthCalledWith(1, {
      where: { id: roomId },
      data: { status: 'PLAYING' },
    });
    expect(roomUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: roomId },
      data: { status: 'WAITING' },
    });
    expect((service as any).rooms.get(roomId).match).toBeNull();
  });

  it('prepares feature flags before persisting PLAYING', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    flags.find.mockImplementationOnce(() => gate.then(() => null));

    const pending = service.startMatch(roomId);
    await Promise.resolve();
    expect(flags.find).toHaveBeenCalledWith('classic_turn_duration');
    expect(roomUpdate).not.toHaveBeenCalled();

    release();
    await expect(pending).resolves.toBe(true);
    expect(roomUpdate).toHaveBeenCalledWith({
      where: { id: roomId },
      data: { status: 'PLAYING' },
    });
  });

  it('serializes status writes instead of dispatching them eagerly', async () => {
    const writeStatus = (status: 'PLAYING' | 'WAITING') =>
      (service as any).writeRoomStatus(roomId, status) as Promise<void>;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    roomUpdate.mockImplementationOnce(() => firstGate.then(() => ({})));

    const first = writeStatus('PLAYING');
    await flush();
    expect(roomUpdate).toHaveBeenCalledTimes(1);
    expect(roomUpdate).toHaveBeenLastCalledWith({
      where: { id: roomId },
      data: { status: 'PLAYING' },
    });

    // Enqueued while the first write is in flight: it must not run early.
    const second = writeStatus('WAITING');
    await flush();
    expect(roomUpdate).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(roomUpdate).toHaveBeenCalledTimes(2);
    expect(roomUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: roomId },
      data: { status: 'WAITING' },
    });
  });

  it('skips a queued status write that became stale before its turn', async () => {
    const writeStatus = (status: 'PLAYING' | 'WAITING') =>
      (service as any).writeRoomStatus(roomId, status) as Promise<void>;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    roomUpdate.mockImplementationOnce(() => firstGate.then(() => ({})));

    const first = writeStatus('PLAYING');
    await flush();
    const stale = writeStatus('WAITING');
    // Supersede the queued WAITING transition before it is dispatched.
    const latest = writeStatus('PLAYING');
    releaseFirst();
    await Promise.all([first, stale, latest]);

    expect(roomUpdate).toHaveBeenCalledTimes(2);
    expect(roomUpdate).toHaveBeenNthCalledWith(1, {
      where: { id: roomId },
      data: { status: 'PLAYING' },
    });
    expect(roomUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: roomId },
      data: { status: 'PLAYING' },
    });
  });
});

describe('GameStateService settings persistence', () => {
  const roomId = 'room-settings';
  let service: GameStateService;
  let roomUpdate: jest.Mock;
  let events: RoomEvent[];

  beforeEach(() => {
    roomUpdate = jest.fn().mockResolvedValue({});
    service = new GameStateService(
      {} as never,
      { room: { update: roomUpdate }, match: { create: jest.fn() } } as never,
      {} as never,
    );
    service.initRoom(roomId, 'host', 'Host', {
      mode: 'CLASSIC',
      maxPlayers: 2,
      rounds: 1,
      turnDuration: 60,
      difficulty: 'MIXED',
      enableHints: false,
    } as never);
    events = [];
    service.registerSink(roomId, event => events.push(event));
  });

  afterEach(() => {
    const turn = (service as any).rooms.get(roomId)?.match?.turn;
    if (turn?.timer) clearTimeout(turn.timer);
    for (const t of turn?.hintTimers ?? []) clearTimeout(t);
  });

  it('does not mutate in-memory settings or emit a snapshot when persistence fails', async () => {
    roomUpdate.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    const before = service.getSnapshot(roomId)?.settings;

    const result = await service.updateSettings(roomId, 'host', {
      rounds: 3,
      turnDuration: 90,
      enableHints: true,
    });

    expect(result).toEqual({ ok: false, reason: 'SETTINGS_SAVE_FAILED' });
    expect(isSettingsUpdateFailure(result, 'SETTINGS_SAVE_FAILED')).toBe(true);
    expect(isSettingsUpdateFailure(result, 'MATCH_IN_PROGRESS')).toBe(false);
    expect(service.getSnapshot(roomId)?.settings).toEqual(before);
    expect(events.some(event => event.type === 'room:snapshot')).toBe(false);
    expect(roomUpdate).toHaveBeenCalledTimes(1);
  });

  it('commits settings and emits a snapshot only after the database accepts them', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    roomUpdate.mockImplementationOnce(() => gate.then(() => ({})));
    const before = service.getSnapshot(roomId)?.settings;

    const pending = service.updateSettings(roomId, 'host', { rounds: 3 });
    await Promise.resolve();
    expect(service.getSnapshot(roomId)?.settings).toEqual(before);
    expect(events).toHaveLength(0);

    release();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(service.getSnapshot(roomId)?.settings).toMatchObject({ rounds: 3 });
    expect(events.some(event => event.type === 'room:snapshot')).toBe(true);
  });

  it('rejects a settings write that loses the lock race to startMatch', async () => {
    // Make this room able to run a real startMatch so the race is exercised
    // against the actual lock, not a hand-built match object.
    service.addPlayer(roomId, 'guest', 'Guest');
    service.setReady(roomId, 'guest', true);
    Object.assign(service as any, {
      wordService: {
        pickRandomWords: jest.fn().mockResolvedValue([
          { id: 'word-1', canonical: 'mèo', difficulty: 'EASY', category: 'animals' },
        ]),
        getWordById: jest.fn().mockResolvedValue({ canonical: 'mèo', synonyms: [] }),
        incrementUsage: jest.fn().mockResolvedValue(undefined),
      },
      featureFlags: { find: jest.fn().mockResolvedValue(null) },
    });

    // Capture the callback that withLock will run under the room lock. Calling
    // it directly models a write whose DB call resolves after startMatch has
    // taken the lock and captured the old settings, exercising the re-check
    // that a plain queued update cannot reach.
    let settingsBody!: () => Promise<SettingsUpdateResult>;
    const withLockSpy = jest
      .spyOn(service as any, 'withLock')
      .mockImplementation((...args: unknown[]) => {
        settingsBody = args[1] as () => Promise<SettingsUpdateResult>;
        return Promise.resolve({ ok: false, reason: 'MATCH_IN_PROGRESS' }) as never;
      });

    service.updateSettings(roomId, 'host', { rounds: 3 });
    withLockSpy.mockRestore();

    await expect(service.startMatch(roomId)).resolves.toBe(true);
    const before = service.getSnapshot(roomId)?.settings;

    let releaseSettings!: () => void;
    const settingsGate = new Promise<void>(resolve => {
      releaseSettings = resolve;
    });
    roomUpdate.mockImplementationOnce(() => settingsGate.then(() => ({})));

    const persisted = settingsBody();
    await Promise.resolve();
    expect(roomUpdate).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot(roomId)?.settings).toEqual(before);

    releaseSettings();
    await expect(persisted).resolves.toEqual({ ok: false, reason: 'MATCH_IN_PROGRESS' });
    expect(service.getSnapshot(roomId)?.settings).toEqual(before);
    expect(events.some(event => event.type === 'room:snapshot')).toBe(false);
  });
});
