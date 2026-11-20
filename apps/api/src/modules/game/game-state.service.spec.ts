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
