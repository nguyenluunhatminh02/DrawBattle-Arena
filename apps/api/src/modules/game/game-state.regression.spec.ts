import { GameStateService, RoomEvent } from './game-state.service';
import { GAME_CONSTANTS } from '@drawbattle/shared';

/**
 * Regression matrix for the authoritative in-memory game state machine.
 * These tests do not use Prisma/Redis: initRoom/addPlayer/turn helpers only
 * touch local Maps, so lightweight stubs are sufficient.
 */
describe('GameStateService regressions', () => {
  let service: GameStateService;
  let events: RoomEvent[];

  const settings = (overrides: Record<string, unknown> = {}) =>
    ({
      mode: 'CLASSIC',
      maxPlayers: 4,
      rounds: 1,
      turnDuration: 60,
      difficulty: 'MIXED',
      enableHints: true,
      ...overrides,
    }) as never;

  const setup = (roomId: string, overrides: Record<string, unknown> = {}, ids = ['host', 'guest', 'third']) => {
    service.initRoom(roomId, 'host', 'Host', settings(overrides));
    for (const id of ids.slice(1)) {
      expect(service.addPlayer(roomId, id, id)).not.toBeNull();
    }
    events = [];
    service.registerSink(roomId, event => events.push(event));
  };

  /** Drive a room into DRAWING with a known word without invoking timers/DB. */
  const startDrawing = (roomId: string, drawerId = 'host', word = 'con mèo') => {
    const room = (service as any).rooms.get(roomId);
    const turnId = `turn-${roomId}`;
    const now = Date.now();
    room.match = {
      id: `match-${roomId}`,
      rounds: 1,
      totalTurns: 2,
      currentRound: 1,
      drawerOrder: [drawerId, 'guest'],
      currentDrawerIndex: 0,
      startedAt: now,
      turnDuration: 60,
      enableHints: false,
      completedTurns: [],
      turn: {
        id: turnId,
        drawerId,
        wordId: 'word-1',
        word,
        synonyms: ['mèo'],
        phase: 'DRAWING',
        startedAt: now,
        endsAt: now + 60_000,
        timeLimit: 60,
        strokes: [],
        guesses: [],
        correctGuessers: new Set<string>(),
        firstCorrectId: null,
        wordOptions: [],
        hintPhase: 'none',
        timer: setTimeout(() => undefined, 60_000),
        hintTimers: [],
        ended: false,
      },
    };
    return turnId;
  };

  beforeEach(() => {
    service = new GameStateService({} as never, {} as never, {} as never, {} as never);
    events = [];
  });

  afterEach(() => {
    // Clear any turn timers created by startDrawing so Jest can exit cleanly.
    for (const roomId of ['r-scoring', 'r-authorization', 'r-strokes', 'r-reconnect', 'r-privacy']) {
      const turn = (service as any).rooms.get(roomId)?.match?.turn;
      if (turn?.timer) clearTimeout(turn.timer);
      for (const t of turn?.hintTimers ?? []) clearTimeout(t);
    }
  });

  // TEST-09: a correct guess scores once; repeats are ignored.
  it('TEST-09 awards points only once per guesser per turn', () => {
    setup('r-scoring');
    startDrawing('r-scoring');
    const first = service.submitGuess('r-scoring', 'guest', 'con mèo');
    expect(first.accepted).toBe(true);
    expect(first.correct).toBe(true);
    const score = first.score!;
    expect(score).toBeGreaterThan(0);
    const second = service.submitGuess('r-scoring', 'guest', 'con mèo');
    expect(second.correct).toBe(false);
    expect(service.getPlayers('r-scoring').find(p => p.id === 'guest')!.score).toBe(score);
  });

  // TEST-10: guesses from the drawer and from spectators are never accepted.
  it('TEST-10 rejects drawer and non-player guesses', () => {
    setup('r-authorization');
    startDrawing('r-authorization');
    expect(service.submitGuess('r-authorization', 'host', 'con mèo')).toEqual({
      accepted: false,
      correct: false,
    });
    expect(service.submitGuess('r-authorization', 'intruder', 'con mèo')).toEqual({
      accepted: false,
      correct: false,
    });
  });

  // TEST-11: draw authorization checks room, drawer identity and turn id.
  it('TEST-11 only the active drawer can submit strokes or mutate the canvas', () => {
    setup('r-strokes');
    const turnId = startDrawing('r-strokes');
    const chunk = {
      turnId,
      strokeId: 's1',
      seq: 1,
      points: [{ x: 0.2, y: 0.3 }],
      color: '#000000',
      width: 2,
    } as never;
    expect(service.canDraw('r-strokes', 'guest', turnId)).toBe(false);
    expect(service.submitStroke('r-strokes', 'guest', chunk)).toBe(false);
    expect(service.submitStroke('r-strokes', 'host', chunk)).toBe(true);
    expect(service.undoStroke('r-strokes', 'guest')).toBeNull();
    expect(service.clearCanvas('r-strokes', 'guest')).toBe(false);
    expect(service.undoStroke('r-strokes', 'host')).toBe('s1');
  });

  // TEST-12: oversized/corrupt stroke payloads cannot be persisted or broadcast.
  it('TEST-12 rejects oversized and out-of-order stroke chunks', () => {
    setup('r-strokes');
    const turnId = startDrawing('r-strokes');
    const chunk = (overrides: Record<string, unknown> = {}): never =>
      ({
        turnId,
        strokeId: 's1',
        seq: 1,
        points: [{ x: 0.2, y: 0.3 }],
        color: '#000000',
        width: 2,
        ...overrides,
      }) as never;
    expect(service.submitStroke('r-strokes', 'host', chunk({ turnId: 'other' }))).toBe(false);
    expect(
      service.submitStroke('r-strokes', 'host', chunk({
        points: new Array(GAME_CONSTANTS.MAX_POINTS_PER_STROKE + 1).fill({ x: 0.1, y: 0.1 }),
      })),
    ).toBe(false);
    expect(service.submitStroke('r-strokes', 'host', chunk())).toBe(true);
    expect(service.submitStroke('r-strokes', 'host', chunk({ seq: 0 }))).toBe(false);
    expect(events.filter(e => e.type === 'draw:chunk')).toHaveLength(1);
  });

  // TEST-13: reconnect preserves identity instead of creating a duplicate player.
  it('TEST-13 reconnecting a full room reuses the existing player row', () => {
    setup('r-reconnect', { maxPlayers: 2 }, ['host', 'guest']);
    service.setPlayerOnline('r-reconnect', 'guest', false);
    expect(service.addPlayer('r-reconnect', 'third', 'Third')).toBeNull();
    const reconnected = service.addPlayer('r-reconnect', 'guest', 'Guest');
    expect(reconnected?.id).toBe('guest');
    expect(reconnected?.isOnline).toBe(true);
    expect(service.getPlayers('r-reconnect')).toHaveLength(2);
  });

  // TEST-14: snapshots expose hasPassword but never password or hash.
  it('TEST-14 snapshots redact room password fields', () => {
    setup('r-privacy', { passwordHash: 'secret-hash' });
    const snapshot = service.getSnapshot('r-privacy');
    expect(snapshot?.hasPassword).toBe(true);
    expect(snapshot?.settings).not.toHaveProperty('passwordHash');
    expect(snapshot?.settings).not.toHaveProperty('password');
  });

  // Extra: public turn snapshots include strokes but never the secret word.
  it('never includes the secret word in public turn state', () => {
    setup('r-privacy');
    startDrawing('r-privacy');
    const snapshot = service.getTurnSnapshot('r-privacy');
    expect(snapshot).not.toHaveProperty('word');
    expect(service.getDrawerWord('r-privacy', 'guest')).toBeNull();
    expect(service.getDrawerWord('r-privacy', 'host')).toBe('con mèo');
    const publicState = events.find(e => e.type === 'turn:publicState');
    expect(publicState).toBeUndefined();
  });
});
