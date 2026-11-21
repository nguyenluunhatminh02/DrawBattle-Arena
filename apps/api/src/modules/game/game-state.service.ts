import { Injectable, Logger, Optional } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import {
  calculateDrawerScore,
  calculateGuesserScore,
  GAME_CONSTANTS,
  generateHint,
  getModeConfig,
  normalizeGuess,
  validateGuess,
} from '@drawbattle/shared';
import type {
  GamePhase,
  PlayerInfo,
  RoomSettings,
  StrokeChunk,
  TeamResult,
  TeamResults,
  TurnSnapshot,
} from '@drawbattle/shared';
import { Prisma } from '@prisma/client';
import { WordService } from '../word/word.service';
import { PrismaService } from '../../prisma/prisma.service';
import { FeatureFlagService } from '../feature-flag/feature-flag.service';
import { ReplayJobService } from '../replay/replay-jobs';
import { censorProfanity } from '../../common/profanity';

interface RoomState {
  roomId: string;
  hostId: string;
  players: Map<string, PlayerState>;
  settings: RoomSettings;
  match: MatchState | null;
  teams?: { teamA: string[]; teamB: string[] };
  /** Monotonic generation; invalidates queued status writes after a reset. */
  statusGeneration?: number;
}

/** Bounded retries for critical room.status transitions. */
const STATUS_WRITE_ATTEMPTS = 3;
const STATUS_RETRY_BASE_DELAY_MS = 20;

interface PlayerState {
  id: string;
  nickname: string;
  avatar?: string;
  isHost: boolean;
  isReady: boolean;
  isOnline: boolean;
  score: number;
  hasCorrectGuess: boolean;
  usedHint: boolean;
  lastGuessAt: number;
  lastChatAt: number;
  isMuted: boolean;
  isKicked: boolean;
  guessesThisTurn: number;
}

interface GuessRecord {
  playerId: string;
  guessText: string;
  normalizedText: string;
  correct: boolean;
  receivedAt: number;
}

interface CompletedTurn {
  id: string;
  drawerId: string;
  wordId: string;
  strokes: StrokeChunk[];
  startedAt: number;
  endsAt: number;
  correctCount: number;
  guesses: GuessRecord[];
}

interface MatchState {
  id: string;
  rounds: number;
  totalTurns: number;
  currentRound: number;
  drawerOrder: string[];
  currentDrawerIndex: number;
  turn: TurnState | null;
  completedTurns: CompletedTurn[];
  turnDuration?: number;
  enableHints?: boolean;
  startedAt: number;
}

interface TurnState {
  id: string;
  drawerId: string;
  wordId: string | null;
  word: string | null;
  synonyms: string[];
  phase: GamePhase;
  startedAt: number;
  endsAt: number;
  timeLimit: number;
  strokes: StrokeChunk[];
  guesses: GuessRecord[];
  correctGuessers: Set<string>;
  firstCorrectId: string | null;
  wordOptions: Array<{ id: string; canonical: string; difficulty: string; category: string }>;
  hintPhase: 'none' | 'first' | 'second';
  timer: NodeJS.Timeout | null;
  hintTimers: NodeJS.Timeout[];
  ended: boolean;
}

export interface RoomEvent {
  type: string;
  payload: unknown;
  targetId?: string | null;
}

export type EventSink = (event: RoomEvent) => void;

/** Discriminated settings-update result. Truthy for `ok: true`, falsy otherwise. */
export type SettingsUpdateResult =
  | { ok: true; reason?: undefined }
  | { ok: false; reason: 'ROOM_NOT_FOUND' | 'NOT_HOST' | 'MATCH_IN_PROGRESS' | 'SETTINGS_SAVE_FAILED' };

export type SettingsUpdateFailureReason = Extract<SettingsUpdateResult, { ok: false }>['reason'];

/** Lets callers preserve legacy boolean handling while distinguishing failures. */
export function isSettingsUpdateFailure(
  result: SettingsUpdateResult,
  reason: SettingsUpdateFailureReason,
): boolean {
  return result.ok === false && result.reason === reason;
}

@Injectable()
export class GameStateService {
  private readonly logger = new Logger(GameStateService.name);
  private readonly rooms = new Map<string, RoomState>();
  private readonly sinks = new Map<string, EventSink>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly autoEndTimers = new Map<string, NodeJS.Timeout>();
  /** Pending room.status writes; awaited by startMatch so DB/memory cannot drift silently. */
  private readonly pendingStatusWrites = new Map<string, Promise<void>>();
  /** Generations for rooms already removed from memory (e.g. last player left). */
  private readonly retiredStatusGenerations = new Map<string, number>();

  constructor(
    private readonly wordService: WordService,
    private readonly prisma: PrismaService,
    private readonly featureFlags: FeatureFlagService,
    @Optional() private readonly replayJobs?: ReplayJobService,
  ) {}

  registerSink(roomId: string, sink: EventSink) {
    this.sinks.set(roomId, sink);
  }

  unregisterSink(roomId: string) {
    this.sinks.delete(roomId);
  }

  private withLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(roomId) ?? Promise.resolve();
    let release: () => void;
    const gate = new Promise<void>(r => (release = r));
    const next = prev.then(() => gate);
    this.locks.set(roomId, next);
    return prev.then(() => fn()).finally(() => {
      release!();
      if (this.locks.get(roomId) === next) {
        this.locks.delete(roomId);
      }
    });
  }

  /**
   * Persists a critical room.status change with a bounded retry budget. The
   * returned promise resolves only after the DB acknowledges the write (or all
   * retries failed), so callers can await it instead of silently forgetting it.
   * A statusGeneration check prevents a slow retry from resurrecting a stale
   * status after a newer transition (e.g. WAITING after the match ended).
   */
  private writeRoomStatus(roomId: string, status: 'PLAYING' | 'WAITING'): Promise<void> {
    const room = this.rooms.get(roomId);
    const generation = Math.max(room?.statusGeneration ?? 0, this.retiredStatusGenerations.get(roomId) ?? 0) + 1;
    if (room) room.statusGeneration = generation;
    else this.retiredStatusGenerations.set(roomId, generation);

    const isCurrent = () =>
      (this.rooms.get(roomId)?.statusGeneration ?? this.retiredStatusGenerations.get(roomId) ?? 0) === generation;
    const skipStale = () => {
      this.logger.warn(
        `Skipped stale room status write ${status} for ${roomId} after generation change`,
      );
    };

    const previous = this.pendingStatusWrites.get(roomId) ?? Promise.resolve();
    // The update must be dispatched only once the previous write has settled,
    // and only while this transition is still the newest one.
    const chained = previous.catch(() => undefined).then(async () => {
      if (!isCurrent()) {
        skipStale();
        return;
      }
      for (let attempt = 0; attempt < STATUS_WRITE_ATTEMPTS; attempt++) {
        // A retry must not resurrect a status superseded while the DB call was
        // in flight.
        if (!isCurrent()) {
          skipStale();
          return;
        }
        try {
          await this.prisma.room.update({
            where: { id: roomId },
            data: { status },
          });
          return;
        } catch (err) {
          const retryable =
            (err as { code?: unknown })?.code === 'P2034' ||
            (err as { meta?: { code?: unknown } })?.meta?.code === '40001';
          if (!retryable || attempt === STATUS_WRITE_ATTEMPTS - 1) {
            this.logger.error(
              `Failed to persist room ${roomId} status=${status} after ${attempt + 1} attempt(s)`,
              err instanceof Error ? err.message : String(err),
            );
            throw err;
          }
          await new Promise(resolve => setTimeout(resolve, STATUS_RETRY_BASE_DELAY_MS * (attempt + 1)));
        }
      }
    });
    this.pendingStatusWrites.set(roomId, chained);
    const clearPending = () => {
      if (this.pendingStatusWrites.get(roomId) === chained) {
        this.pendingStatusWrites.delete(roomId);
      }
    };
    // Callers may fire-and-forget this write, and .finally()/.then() create a
    // derived promise: both must observe rejection or a P2034 becomes an
    // unhandled rejection that crashes the process.
    void chained.catch(() => undefined);
    void chained.then(clearPending, clearPending);
    return chained;
  }

  /** Waits for queued status writes to settle (used before starting a match). */
  private async flushStatusWrites(roomId: string): Promise<void> {
    const pending = this.pendingStatusWrites.get(roomId);
    if (pending) await pending;
  }

  initRoom(
    roomId: string,
    hostId: string,
    hostNickname: string,
    settings: RoomSettings,
  ) {
    // Keep the fencing generation monotonic across room recreations. A WAITING
    // write queued while the previous lifetime existed must stay stale after a
    // new lifetime is initialized, so start the new room strictly above the
    // highest generation ever issued for this room id.
    const previousGeneration = Math.max(
      this.rooms.get(roomId)?.statusGeneration ?? 0,
      this.retiredStatusGenerations.get(roomId) ?? 0,
    );
    const players = new Map<string, PlayerState>();
    players.set(hostId, {
      id: hostId,
      nickname: hostNickname,
      isHost: true,
      isReady: false,
      isOnline: true,
      score: 0,
      hasCorrectGuess: false,
      usedHint: false,
      lastGuessAt: 0,
      lastChatAt: 0,
      isMuted: false,
      isKicked: false,
      guessesThisTurn: 0,
    });
    this.rooms.set(roomId, {
      roomId,
      hostId,
      players,
      settings,
      match: null,
      statusGeneration: previousGeneration,
    });
  }

  addPlayer(roomId: string, id: string, nickname: string): PlayerInfo | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    // Reconnects must bypass capacity: the slot is already occupied by this
    // identity, and rejecting it would roll back the player's DB row.
    if (room.players.has(id)) {
      const p = room.players.get(id)!;
      p.isOnline = true;
      // A reconnecting player increases the eligible-guesser count, so a
      // pending auto-end timer must be cleared and turn timing re-evaluated.
      const autoTimer = this.autoEndTimers.get(roomId);
      if (autoTimer) {
        clearTimeout(autoTimer);
        this.autoEndTimers.delete(roomId);
        const turn = room.match?.turn;
        if (turn && turn.phase === 'DRAWING' && !turn.ended) {
          const eligible = Array.from(room.players.values()).filter(
            pp => pp.id !== turn.drawerId && pp.isOnline && !this.isTeammate(room, turn.drawerId, pp.id),
          );
          if (turn.correctGuessers.size < eligible.length) {
            const remaining = Math.max(0, turn.endsAt - Date.now());
            if (turn.timer) clearTimeout(turn.timer);
            turn.timer = setTimeout(() => void this.endTurn(roomId), remaining);
          }
        }
      }
      return this.toPlayerInfo(p);
    }
    if (room.players.size >= room.settings.maxPlayers) return null;
    const player: PlayerState = {
      id,
      nickname,
      isHost: false,
      isReady: false,
      isOnline: true,
      score: 0,
      hasCorrectGuess: false,
      usedHint: false,
      lastGuessAt: 0,
      lastChatAt: 0,
      isMuted: false,
      isKicked: false,
      guessesThisTurn: 0,
    };
    room.players.set(id, player);
    return this.toPlayerInfo(player);
  }

  removePlayer(roomId: string, playerId: string): string | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const turn = room.match?.turn ?? null;
    const wasActiveDrawer =
      !!turn &&
      turn.drawerId === playerId &&
      !turn.ended &&
      (turn.phase === 'WORD_PICK' || turn.phase === 'DRAWING');

    room.players.delete(playerId);
    if (room.teams) {
      room.teams.teamA = room.teams.teamA.filter(id => id !== playerId);
      room.teams.teamB = room.teams.teamB.filter(id => id !== playerId);
    }

    if (room.players.size === 0) {
      if (turn) {
        turn.ended = true;
        if (turn.timer) clearTimeout(turn.timer);
        for (const t of turn.hintTimers) clearTimeout(t);
      }
      room.match = null;
      this.rooms.delete(roomId);
      this.unregisterSink(roomId);
      // Bounded retry with a generation guard: a slow retry must not
      // resurrect a PLAYING status after the room has been recreated.
      void this.writeRoomStatus(roomId, 'WAITING');
      return null;
    }

    if (room.hostId === playerId) {
      const newHost = room.players.values().next().value as PlayerState;
      newHost.isHost = true;
      room.hostId = newHost.id;
      this.emit(roomId, { type: 'room:hostChanged', payload: newHost.id });
      void this.prisma.room
        .update({ where: { id: roomId }, data: { hostPlayerId: newHost.id } })
        .catch(err => this.logger.error('Failed to persist host transfer on leave', err instanceof Error ? err.message : String(err)));
    }

    if (room.match) {
      const modeConfig = getModeConfig(room.settings.mode || 'CLASSIC');
      if (room.players.size < modeConfig.minPlayers) {
        if (turn && !turn.ended) {
          turn.ended = true;
          if (turn.timer) clearTimeout(turn.timer);
          for (const t of turn.hintTimers) clearTimeout(t);
          turn.timer = null;
          turn.hintTimers = [];
        }
        void this.endMatch(roomId);
      } else if (wasActiveDrawer) {
        this.abortCurrentTurn(roomId);
      }
    }

    return room.hostId;
  }

  setPlayerOnline(roomId: string, playerId: string, online: boolean) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const p = room.players.get(playerId);
    if (p) p.isOnline = online;
  }

  setReady(roomId: string, playerId: string, ready: boolean) {
    const room = this.rooms.get(roomId);
    const p = room?.players.get(playerId);
    if (p) p.isReady = ready;
  }

  getSnapshot(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const settings = room.settings as unknown as Record<string, unknown>;
    const hasPassword = Boolean(settings.passwordHash || settings.password);
    const { password: _p, passwordHash: _h, ...safeSettings } = settings;
    return {
      id: room.roomId,
      code: '',
      hostId: room.hostId,
      hasPassword,
      players: Array.from(room.players.values()).map(p => this.toPlayerInfo(p)),
      settings: safeSettings,
      status: room.match ? 'PLAYING' : 'WAITING',
    };
  }

  getPlayers(roomId: string): PlayerInfo[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.players.values()).map(p => this.toPlayerInfo(p));
  }

  canStartMatch(roomId: string, playerId: string): { ok: boolean; reason?: string; message?: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: 'ROOM_NOT_FOUND', message: 'Room not found' };
    if (room.hostId !== playerId) return { ok: false, reason: 'NOT_HOST', message: 'Only host can start' };
    if (room.match) return { ok: false, reason: 'MATCH_IN_PROGRESS', message: 'Match already in progress' };
    const modeConfig = getModeConfig(room.settings.mode || 'CLASSIC');
    const eligible = Array.from(room.players.values()).filter(p => !p.isKicked);
    if (eligible.length < modeConfig.minPlayers) {
      return { ok: false, reason: 'NOT_ENOUGH_PLAYERS', message: `Need at least ${modeConfig.minPlayers} players` };
    }
    const notReady = eligible.filter(p => p.id !== room.hostId && !p.isReady);
    if (notReady.length > 0) {
      return { ok: false, reason: 'PLAYERS_NOT_READY', message: `Chờ sẵn sàng: ${notReady.map(p => p.nickname).join(', ')}` };
    }
    return { ok: true };
  }

  async startMatch(roomId: string): Promise<boolean> {
    return this.withLock(roomId, async () => {
      const room = this.rooms.get(roomId);
      if (!room) return false;

      const modeConfig = getModeConfig(room.settings.mode || 'CLASSIC');
      const eligible = Array.from(room.players.values()).filter(p => !p.isKicked);
      if (eligible.length < modeConfig.minPlayers) return false;
      if (eligible.some(p => p.id !== room.hostId && !p.isReady)) return false;
      if (room.match) return false;

      // Prepare everything that can fail before persisting PLAYING, so an init
      // failure never leaves the room PLAYING in the DB but WAITING in memory.
      let nextMatch: MatchState;
      let wordOptions: Awaited<ReturnType<WordService['pickRandomWords']>>;
      try {
        let turnDuration =
          room.settings.mode === 'SPEED' || room.settings.mode === 'DUEL'
            ? modeConfig.turnDuration
            : room.settings.turnDuration;
        let enableHints = room.settings.enableHints;
        if ((room.settings.mode || 'CLASSIC') === 'CLASSIC') {
          const durationFlag = await this.featureFlags.find('classic_turn_duration');
          if (durationFlag?.enabled && durationFlag.variant) {
            const variant = parseInt(durationFlag.variant, 10);
            if (Number.isFinite(variant) && variant >= 10 && variant <= 180) {
              turnDuration = variant;
            }
          }
          const hintsFlag = await this.featureFlags.find('classic_hints');
          if (hintsFlag) enableHints = hintsFlag.enabled;
        }

        const drawerOrder = this.shuffle(eligible.slice(0, modeConfig.maxPlayers).map(p => p.id));
        const rounds = room.settings.mode === 'DUEL' ? modeConfig.rounds : room.settings.rounds;
        const totalTurns =
          room.settings.mode === 'DUEL' ? modeConfig.rounds : rounds * drawerOrder.length;
        nextMatch = {
          id: uuid(),
          rounds,
          totalTurns,
          currentRound: 1,
          drawerOrder,
          currentDrawerIndex: 0,
          turn: null,
          completedTurns: [],
          turnDuration,
          enableHints,
          startedAt: Date.now(),
        };
        wordOptions = await this.wordService.pickRandomWords(3, {
          difficulty: room.settings.difficulty,
          category: room.settings.category,
        });
      } catch (err) {
        this.logger.error(`startMatch init failed for ${roomId}`, err instanceof Error ? err.message : String(err));
        return false;
      }

      room.match = nextMatch;
      try {
        // Drain any prior status transition (e.g. endMatch -> WAITING) before
        // writing PLAYING, so the DB and in-memory state cannot drift when a
        // rematch starts immediately after the previous match finished.
        await this.flushStatusWrites(roomId);
        await this.writeRoomStatus(roomId, 'PLAYING');
      } catch (err) {
        room.match = null;
        this.logger.error(
          `startMatch aborted for ${roomId}: status write failed`,
          err instanceof Error ? err.message : String(err),
        );
        return false;
      }

      for (const p of room.players.values()) {
        p.score = 0;
      }

      const matchId = room.match!.id;
      const rounds = room.match!.rounds;
      const drawerOrder = room.match!.drawerOrder;

      if (room.settings.mode === 'TEAM') {
        const shuffled = this.shuffle(drawerOrder);
        const mid = Math.ceil(shuffled.length / 2);
        room.teams = {
          teamA: shuffled.slice(0, mid),
          teamB: shuffled.slice(mid),
        };
        const toMembers = (ids: string[]) =>
          ids.map(id => ({ id, nickname: room.players.get(id)?.nickname ?? '?' }));
        this.emit(roomId, {
          type: 'match:teams',
          payload: { teamA: toMembers(room.teams.teamA), teamB: toMembers(room.teams.teamB) },
        });
      } else {
        room.teams = undefined;
      }

      this.emit(roomId, {
        type: 'match:started',
        payload: { matchId, round: 1, totalRounds: rounds, drawerOrder: drawerOrder.map((id: string) => ({ id, nickname: room.players.get(id)?.nickname || '?' })) },
      });

      try {
        await this.startWordPickPhase(roomId, wordOptions);
      } catch (err) {
        // PLAYING is already in the DB: compensate rather than leaving a
        // phantom PLAYING room with no match state. Awaiting keeps the rollback
        // ordered ahead of a subsequent rematch's status writes.
        room.match = null;
        this.logger.error(`startMatch word pick setup failed for ${roomId}`, err instanceof Error ? err.message : String(err));
        try {
          await this.writeRoomStatus(roomId, 'WAITING');
        } catch (rollbackErr) {
          this.logger.error(
            `startMatch failed to roll back status for ${roomId}`,
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          );
        }
        return false;
      }

      return true;
    });
  }

  private async startWordPickPhase(
    roomId: string,
    prefetchedOptions?: Awaited<ReturnType<WordService['pickRandomWords']>>,
  ) {
    const room = this.rooms.get(roomId);
    if (!room || !room.match) return;

    let drawerId = room.match.drawerOrder[room.match.currentDrawerIndex % room.match.drawerOrder.length];
    let skips = 0;
    while (!room.players.has(drawerId) && skips < room.match.drawerOrder.length) {
      room.match.currentDrawerIndex++;
      skips++;
      if (room.match.currentDrawerIndex >= room.match.totalTurns) {
        void this.endMatch(roomId);
        return;
      }
      drawerId = room.match.drawerOrder[room.match.currentDrawerIndex % room.match.drawerOrder.length];
    }
    if (!room.players.has(drawerId)) {
      void this.endMatch(roomId);
      return;
    }
    const options =
      prefetchedOptions ??
      (await this.wordService.pickRandomWords(3, {
        difficulty: room.settings.difficulty,
        category: room.settings.category,
      }));
    if (!this.rooms.get(roomId)?.match) return;

    const modeConfig = getModeConfig(room.settings.mode || 'CLASSIC');
    const wordPickDuration = modeConfig.wordPickDuration;

    const turnId = uuid();
    const now = Date.now();
    const endsAt = now + wordPickDuration * 1000;

    room.match.turn = {
      id: turnId,
      drawerId,
      wordId: null,
      word: null,
      synonyms: [],
      phase: 'WORD_PICK',
      startedAt: now,
      endsAt,
      timeLimit: wordPickDuration,
      strokes: [],
      guesses: [],
      correctGuessers: new Set(),
      firstCorrectId: null,
      wordOptions: options,
      hintPhase: 'none',
      timer: null,
      hintTimers: [],
      ended: false,
    };

    for (const p of room.players.values()) {
      p.hasCorrectGuess = false;
      p.usedHint = false;
      p.guessesThisTurn = 0;
    }

    this.emit(roomId, {
      type: 'turn:youAreDrawer',
      payload: { words: options, timeLimit: wordPickDuration, turnId },
      targetId: drawerId,
    });
    this.emit(roomId, {
      type: 'turn:publicState',
      payload: { drawerId, timeLimit: wordPickDuration, turnId },
    });

    const autoSelectTimer = setTimeout(() => {
      const current = this.rooms.get(roomId)?.match?.turn;
      if (current && current.phase === 'WORD_PICK' && !current.wordId && current.wordOptions[0]) {
        void this.chooseWord(roomId, drawerId, current.wordOptions[0].id).catch(err => {
          this.logger.error(
            `Auto word selection failed for room ${roomId}`,
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    }, wordPickDuration * 1000);

    room.match.turn.timer = autoSelectTimer;
  }

  async chooseWord(roomId: string, playerId: string, wordId: string): Promise<boolean> {
    return this.withLock(roomId, async () => {
      const room = this.rooms.get(roomId);
      const turn = room?.match?.turn;
      if (!room || !turn || turn.phase !== 'WORD_PICK') return false;
      if (turn.drawerId !== playerId) return false;
      if (turn.wordId) return false;
      const option = turn.wordOptions.find(w => w.id === wordId);
      if (!option) return false;

      const word = await this.wordService.getWordById(wordId);
      if (!word) return false;

      if (turn.timer) clearTimeout(turn.timer);
      turn.timer = null;

      turn.wordId = wordId;
      turn.word = word.canonical;
      turn.synonyms = (word.synonyms as string[]) ?? [];
      await this.wordService.incrementUsage(wordId);

      await this.startDrawingPhase(roomId);
      return true;
    });
  }

  private async startDrawingPhase(roomId: string) {
    const room = this.rooms.get(roomId);
    const turn = room?.match?.turn;
    if (!room || !turn) return;

    const now = Date.now();
    const timeLimit = room.match?.turnDuration ?? room.settings.turnDuration;
    const hintsEnabled = room.match?.enableHints ?? room.settings.enableHints;
    turn.phase = 'DRAWING';
    turn.startedAt = now;
    turn.endsAt = now + timeLimit * 1000;
    turn.timeLimit = timeLimit;
    turn.strokes = [];

    this.emit(roomId, {
      type: 'match:phaseChanged',
      payload: {
        phase: 'DRAWING',
        turnId: turn.id,
        drawerId: turn.drawerId,
        endsAt: turn.endsAt,
        ...(hintsEnabled ? { hint: generateHint(turn.word!, 'first') } : {}),
      },
    });
    this.emit(roomId, {
      type: 'turn:yourWord',
      payload: { word: turn.word },
      targetId: turn.drawerId,
    });

    if (hintsEnabled) {
      const firstHintAt = Math.floor(timeLimit * GAME_CONSTANTS.HINT_FIRST_PERCENT / 100) * 1000;
      const secondHintAt = Math.floor(timeLimit * GAME_CONSTANTS.HINT_SECOND_PERCENT / 100) * 1000;
      const firstTimer = setTimeout(() => {
        if (turn.phase === 'DRAWING') {
          turn.hintPhase = 'first';
          this.emit(roomId, { type: 'turn:hint', payload: { hint: generateHint(turn.word!, 'first') } });
        }
      }, firstHintAt);
      const secondTimer = setTimeout(() => {
        if (turn.phase === 'DRAWING') {
          turn.hintPhase = 'second';
          this.emit(roomId, { type: 'turn:hint', payload: { hint: generateHint(turn.word!, 'second') } });
        }
      }, secondHintAt);
      turn.hintTimers.push(firstTimer, secondTimer);
    }

    turn.timer = setTimeout(() => {
      void this.endTurn(roomId);
    }, timeLimit * 1000);
  }

  canDraw(roomId: string, playerId: string, turnId: string): boolean {
    const room = this.rooms.get(roomId);
    const turn = room?.match?.turn;
    return !!room && !!turn && turn.phase === 'DRAWING' && turn.drawerId === playerId && turn.id === turnId;
  }

  getDrawerWord(roomId: string, playerId: string): string | null {
    const turn = this.rooms.get(roomId)?.match?.turn;
    if (!turn || turn.phase !== 'DRAWING' || turn.drawerId !== playerId) return null;
    return turn.word;
  }

  submitStroke(roomId: string, playerId: string, chunk: StrokeChunk): boolean {
    const room = this.rooms.get(roomId);
    const turn = room?.match?.turn;
    if (!room || !turn || turn.phase !== 'DRAWING') return false;
    if (turn.drawerId !== playerId) return false;
    if (chunk.turnId !== turn.id) return false;
    const payloadSize = JSON.stringify(chunk).length;
    if (payloadSize > GAME_CONSTANTS.MAX_STROKE_PAYLOAD_BYTES) return false;
    if (chunk.points.length > GAME_CONSTANTS.MAX_POINTS_PER_STROKE) return false;

    const existing = turn.strokes.find(s => s.strokeId === chunk.strokeId);
    if (existing) {
      if (chunk.seq <= existing.seq) return false;
      if (existing.points.length + chunk.points.length > GAME_CONSTANTS.MAX_POINTS_PER_STROKE) return false;
      existing.points.push(...chunk.points);
      existing.seq = chunk.seq;
    } else {
      if (turn.strokes.length >= GAME_CONSTANTS.MAX_STROKES_PER_TURN) return false;
      turn.strokes.push({ ...chunk, points: [...chunk.points] });
    }
    this.emit(roomId, { type: 'draw:chunk', payload: chunk });
    return true;
  }

  clearCanvas(roomId: string, playerId: string): boolean {
    const room = this.rooms.get(roomId);
    const turn = room?.match?.turn;
    if (!turn || turn.phase !== 'DRAWING' || turn.drawerId !== playerId) return false;
    turn.strokes = [];
    this.emit(roomId, { type: 'draw:reset', payload: null });
    return true;
  }

  undoStroke(roomId: string, playerId: string): string | null {
    const room = this.rooms.get(roomId);
    const turn = room?.match?.turn;
    if (!turn || turn.phase !== 'DRAWING' || turn.drawerId !== playerId) return null;
    const last = turn.strokes.pop();
    if (!last) return null;
    this.emit(roomId, { type: 'draw:undo', payload: last.strokeId });
    return last.strokeId;
  }

  async updateSettings(
    roomId: string,
    hostId: string,
    patch: {
      rounds?: number;
      turnDuration?: number;
      enableHints?: boolean;
      difficulty?: string;
      category?: string;
    },
  ): Promise<SettingsUpdateResult> {
    return this.withLock(roomId, async () => {
      const room = this.rooms.get(roomId);
      if (!room) return { ok: false, reason: 'ROOM_NOT_FOUND' } as const;
      if (room.hostId !== hostId) return { ok: false, reason: 'NOT_HOST' } as const;
      if (room.match) return { ok: false, reason: 'MATCH_IN_PROGRESS' } as const;

      const next: RoomSettings = { ...room.settings };
      if (typeof patch.rounds === 'number') {
        next.rounds = Math.min(3, Math.max(1, Math.round(patch.rounds)));
      }
      if (typeof patch.turnDuration === 'number' && [45, 60, 90].includes(patch.turnDuration)) {
        next.turnDuration = patch.turnDuration;
      }
      if (typeof patch.enableHints === 'boolean') {
        next.enableHints = patch.enableHints;
      }
      if (patch.difficulty && ['EASY', 'MEDIUM', 'HARD', 'MIXED'].includes(patch.difficulty)) {
        next.difficulty = patch.difficulty as RoomSettings['difficulty'];
      }
      if (typeof patch.category === 'string') {
        next.category = patch.category || undefined;
      }
      try {
        await this.prisma.room.update({
          where: { id: roomId },
          data: { settings: next as unknown as Prisma.InputJsonValue },
        });
      } catch (err) {
        this.logger.error(`Failed to persist settings for room ${roomId}`, err instanceof Error ? err.message : String(err));
        return { ok: false, reason: 'SETTINGS_SAVE_FAILED' } as const;
      }

      // A startMatch queued on this room's lock may have begun while the DB call
      // was in flight. The lock serializes the transition, but the match check
      // must be repeated before committing so settings cannot change after
      // startMatch captured them for the new match.
      if (this.rooms.get(roomId) !== room || room.match) {
        return { ok: false, reason: 'MATCH_IN_PROGRESS' } as const;
      }

      // Only commit the in-memory settings after the DB accepted them, so a
      // failed update cannot make RAM and the database disagree.
      room.settings = next;
      this.emit(roomId, { type: 'room:snapshot', payload: this.getSnapshot(roomId) });
      return { ok: true } as const;
    });
  }

  submitGuess(
    roomId: string,
    playerId: string,
    guess: string,
  ): { accepted: boolean; correct: boolean; score?: number } {
    const room = this.rooms.get(roomId);
    const turn = room?.match?.turn;
    if (!room || !turn || turn.phase !== 'DRAWING') {
      return { accepted: false, correct: false };
    }
    if (turn.drawerId === playerId) return { accepted: false, correct: false };
    if (this.isTeammate(room, turn.drawerId, playerId)) {
      return { accepted: false, correct: false };
    }

    const player = room.players.get(playerId);
    if (!player || player.hasCorrectGuess) {
      return { accepted: false, correct: false };
    }

    const now = Date.now();
    if (now - player.lastGuessAt < GAME_CONSTANTS.GUESS_RATE_LIMIT_MS) {
      return { accepted: false, correct: false };
    }
    if (player.guessesThisTurn >= GAME_CONSTANTS.MAX_GUESSES_PER_TURN) {
      return { accepted: false, correct: false };
    }
    player.lastGuessAt = now;
    player.guessesThisTurn++;

    const record = (isCorrect: boolean) => {
      turn.guesses.push({
        playerId,
        guessText: guess,
        normalizedText: normalizeGuess(guess),
        correct: isCorrect,
        receivedAt: now,
      });
    };

    if (!turn.word) {
      record(false);
      return { accepted: true, correct: false };
    }

    const correct = validateGuess(guess, turn.word, turn.synonyms);
    record(correct);
    if (correct) {
      player.hasCorrectGuess = true;
      turn.correctGuessers.add(playerId);
      if (!turn.firstCorrectId) turn.firstCorrectId = playerId;

      const remaining = Math.max(0, Math.floor((turn.endsAt - now) / 1000));
      const isFirst = turn.correctGuessers.size === 1;
      const score = calculateGuesserScore(turn.timeLimit, remaining, isFirst, player.usedHint);
      player.score += score;

      this.emit(roomId, { type: 'guess:correct', payload: { playerId, score } });
      this.emitScores(roomId);

      const eligibleGuessers = Array.from(room.players.values()).filter(
        p => p.id !== turn.drawerId && p.isOnline && !this.isTeammate(room, turn.drawerId, p.id),
      );
      if (turn.correctGuessers.size >= eligibleGuessers.length) {
        if (turn.timer) clearTimeout(turn.timer);
        // Store the auto-end timer so a reconnecting player during the grace
        // period can clear/re-evaluate it (eligible guesser count increased).
        this.autoEndTimers.set(roomId, setTimeout(() => {
          this.autoEndTimers.delete(roomId);
          void this.endTurn(roomId);
        }, 1500));
      }

      return { accepted: true, correct: true, score };
    }

    this.emit(roomId, { type: 'guess:accepted', payload: { playerId }, targetId: playerId });
    this.emit(roomId, {
      type: 'chat:message',
      payload: {
        id: uuid(),
        playerId,
        nickname: player.nickname,
        message: censorProfanity(guess),
        isGuess: true,
        isCorrect: false,
        timestamp: now,
      },
    });

    return { accepted: true, correct: false };
  }

  sendChat(roomId: string, playerId: string, message: string): boolean {
    const room = this.rooms.get(roomId);
    const player = room?.players.get(playerId);
    if (!room || !player) return false;
    const now = Date.now();
    if (now - player.lastChatAt < GAME_CONSTANTS.CHAT_RATE_LIMIT_MS) return false;
    player.lastChatAt = now;
    this.emit(roomId, {
      type: 'chat:message',
      payload: {
        id: uuid(),
        playerId,
        nickname: player.nickname,
        message,
        isGuess: false,
        isCorrect: false,
        timestamp: now,
      },
    });
    return true;
  }

  private abortCurrentTurn(roomId: string) {
    const room = this.rooms.get(roomId);
    const turn = room?.match?.turn;
    if (!room || !room.match || !turn || turn.ended) return;
    turn.ended = true;
    if (turn.timer) clearTimeout(turn.timer);
    for (const t of turn.hintTimers) clearTimeout(t);
    turn.timer = null;
    turn.hintTimers = [];
    const autoTimer = this.autoEndTimers.get(roomId);
    if (autoTimer) {
      clearTimeout(autoTimer);
      this.autoEndTimers.delete(roomId);
    }
    // A DRAWING turn that is aborted (e.g. drawer leaves) already affected
    // in-memory guesses/scores, so keep it for the endMatch flush. A WORD_PICK
    // turn has no wordId and cannot satisfy the Turn.wordId FK, so skip it.
    if (turn.wordId) {
      turn.endsAt = Date.now();
      room.match.completedTurns.push({
        id: turn.id,
        drawerId: turn.drawerId,
        wordId: turn.wordId,
        strokes: turn.strokes,
        startedAt: turn.startedAt,
        endsAt: turn.endsAt,
        correctCount: turn.correctGuessers.size,
        guesses: turn.guesses,
      });
    }
    room.match.turn = null;
    this.emit(roomId, { type: 'match:phaseChanged', payload: { phase: 'NEXT_TURN' } });
    setTimeout(() => this.transitionToNextTurn(roomId), 1000);
  }

  private async endTurn(roomId: string) {
    const room = this.rooms.get(roomId);
    const turn = room?.match?.turn;
    if (!room || !turn) return;
    if (turn.ended) return;
    if (turn.phase === 'REVEAL' || turn.phase === 'MATCH_RESULT') return;

    turn.ended = true;
    if (turn.timer) clearTimeout(turn.timer);
    for (const t of turn.hintTimers) clearTimeout(t);
    turn.timer = null;
    turn.hintTimers = [];
    const autoTimer = this.autoEndTimers.get(roomId);
    if (autoTimer) {
      clearTimeout(autoTimer);
      this.autoEndTimers.delete(roomId);
    }
    turn.phase = 'REVEAL';

    const drawer = room.players.get(turn.drawerId);
    const scoringGuessers = Array.from(turn.correctGuessers).filter(
      id => !this.isTeammate(room, turn.drawerId, id),
    );
    const drawerPoints = calculateDrawerScore(scoringGuessers.length);
    if (drawer) {
      drawer.score += drawerPoints;
    }

    this.emit(roomId, {
      type: 'turn:revealed',
      payload: {
        word: turn.word,
        correctGuessers: Array.from(turn.correctGuessers),
        drawerScore: drawerPoints,
      },
    });
    this.emitScores(roomId);

    if (room.match && turn.wordId) {
      room.match.completedTurns.push({
        id: turn.id,
        drawerId: turn.drawerId,
        wordId: turn.wordId,
        strokes: turn.strokes,
        startedAt: turn.startedAt,
        endsAt: turn.endsAt,
        correctCount: turn.correctGuessers.size,
        guesses: turn.guesses,
      });
    }

    const modeConfig = getModeConfig(room.settings.mode || 'CLASSIC');
    const revealDuration = modeConfig.revealDuration;

    setTimeout(() => {
      void this.transitionToNextTurn(roomId);
    }, revealDuration * 1000);
  }

  private transitionToNextTurn(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room || !room.match) return;

    room.match.currentDrawerIndex++;
    const totalTurns = room.match.totalTurns;
    const completedTurns = room.match.currentDrawerIndex;

    if (completedTurns >= totalTurns) {
      void this.endMatch(roomId);
      return;
    }

    if (completedTurns % room.match.drawerOrder.length === 0 && completedTurns > 0) {
      room.match.currentRound++;
    }

    this.emit(roomId, { type: 'match:phaseChanged', payload: { phase: 'NEXT_TURN' } });

    setTimeout(() => {
      void this.startWordPickPhase(roomId);
    }, 2000);
  }

  private async endMatch(roomId: string) {
    return this.withLock(roomId, async () => {
      const room = this.rooms.get(roomId);
      if (!room || !room.match) return;

      const rankings = Array.from(room.players.values())
        .map(p => ({ playerId: p.id, nickname: p.nickname, points: p.score, rank: 0 }))
        .sort((a, b) => b.points - a.points)
        .map((r, i) => ({ ...r, rank: i + 1 }));

      const matchId = room.match.id;
      const duration = Date.now() - room.match.startedAt;

      let teamsResult: TeamResults | undefined;
      if (room.settings.mode === 'TEAM' && room.teams) {
        const buildTeam = (ids: string[], name: 'A' | 'B'): TeamResult => ({
          name,
          members: ids.map(id => ({ id, nickname: room.players.get(id)?.nickname ?? '?' })),
          points: ids.reduce((sum, id) => sum + (room.players.get(id)?.score ?? 0), 0),
        });
        const teamA = buildTeam(room.teams.teamA, 'A');
        const teamB = buildTeam(room.teams.teamB, 'B');
        teamsResult = {
          teamA,
          teamB,
          winner: teamA.points === teamB.points ? 'DRAW' : teamA.points > teamB.points ? 'A' : 'B',
        };
      }

      const matchState = room.match;
      room.match = null;

      // Reset ready + per-turn flags when the match ends so rematches cannot
      // bypass the ready gate with stale state from the previous match.
      for (const p of room.players.values()) {
        p.isReady = false;
        p.hasCorrectGuess = false;
        p.usedHint = false;
        p.guessesThisTurn = 0;
      }
      // Emit authoritative snapshot so clients see the reset flags.
      this.emit(roomId, { type: 'room:snapshot', payload: this.getSnapshot(roomId) });

      let persistOk = false;
      let replayIds: string[] = [];
      try {
        const completed = matchState.completedTurns;
        const turnsPerRound = Math.max(1, matchState.drawerOrder.length);
        const roundCount = Math.max(1, Math.ceil(completed.length / turnsPerRound));
        const savedMatch = await this.prisma.match.create({
          data: {
            id: matchId,
            roomId,
            status: 'FINISHED',
            rules: room.settings as unknown as Prisma.InputJsonValue,
            endedAt: new Date(),
            scores: {
              create: rankings.map(r => ({ playerId: r.playerId, points: r.points })),
            },
            rounds: {
              create: Array.from({ length: roundCount }, (_, r) => ({
                cycleNo: r + 1,
                endedAt: new Date(),
                turns: {
                  create: completed
                    .slice(r * turnsPerRound, (r + 1) * turnsPerRound)
                    .map(t => ({
                      id: t.id,
                      drawerId: t.drawerId,
                      wordId: t.wordId,
                      status: 'FINISHED' as const,
                      startsAt: new Date(t.startedAt),
                      endsAt: new Date(t.endsAt),
                      result: { correctGuessers: t.correctCount } as Prisma.InputJsonValue,
                      replay: {
                        create: {
                          strokes: t.strokes as unknown as Prisma.InputJsonValue,
                          durationMs: Math.max(0, t.endsAt - t.startedAt),
                        },
                      },
                      guesses: {
                        create: t.guesses.map(g => ({
                          playerId: g.playerId,
                          guessText: g.guessText,
                          normalizedText: g.normalizedText,
                          correct: g.correct,
                          receivedAt: new Date(g.receivedAt),
                        })),
                      },
                    })),
                },
              })),
            },
          },
          include: { rounds: { include: { turns: { include: { replay: true } } } } },
        });
        persistOk = true;
        replayIds = savedMatch.rounds.flatMap(round =>
          round.turns.flatMap(turn => (turn.replay ? [turn.replay.id] : [])),
        );
        this.logger.log(`Match ${matchId} persisted: ${rankings.length} scores, ${completed.length} replays`);
      } catch (err) {
        this.logger.error(`Failed to persist match ${matchId}`, err instanceof Error ? err.message : String(err));
      }

      this.emit(roomId, {
        type: 'match:finished',
        payload: { matchId, rankings, duration, persisted: persistOk, ...(teamsResult ? { teams: teamsResult } : {}) },
      });

      // Only enqueue replays that were actually persisted. queueReplay is
      // idempotent (existing jobs are returned unchanged), so these fire-and-
      // forget calls cannot duplicate renders; the worker alone claims jobs.
      if (persistOk && this.replayJobs) {
        for (const replayId of replayIds) {
          void this.replayJobs.queueReplay(replayId).catch(err => {
            this.logger.error(
              `Failed to queue replay ${replayId} for match ${matchId}`,
              err instanceof Error ? err.message : String(err),
            );
          });
        }
      }

      void this.writeRoomStatus(roomId, 'WAITING');
    });
  }

  getTurnSnapshot(roomId: string): TurnSnapshot | null {
    const turn = this.rooms.get(roomId)?.match?.turn;
    if (!turn) return null;
    return {
      id: turn.id,
      drawerId: turn.drawerId,
      phase: turn.phase,
      endsAt: turn.endsAt,
      strokes: turn.strokes,
    };
  }

  isHost(roomId: string, playerId: string): boolean {
    return this.rooms.get(roomId)?.hostId === playerId;
  }

  kickPlayer(roomId: string, hostId: string, targetId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.hostId !== hostId || hostId === targetId) return false;
    const target = room.players.get(targetId);
    if (!target) return false;
    target.isKicked = true;
    this.emit(roomId, { type: 'room:playerKicked', payload: { playerId: targetId }, targetId });
    this.removePlayer(roomId, targetId);
    return true;
  }

  mutePlayer(roomId: string, hostId: string, targetId: string, muted: boolean): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.hostId !== hostId || hostId === targetId) return false;
    const target = room.players.get(targetId);
    if (!target) return false;
    target.isMuted = muted;
    this.emit(roomId, { type: 'room:playerMuted', payload: { playerId: targetId, muted } });
    return true;
  }

  transferHost(roomId: string, hostId: string, targetId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.hostId !== hostId || hostId === targetId) return false;
    const target = room.players.get(targetId);
    if (!target) return false;
    const oldHost = room.players.get(hostId);
    if (oldHost) oldHost.isHost = false;
    target.isHost = true;
    room.hostId = targetId;
    this.emit(roomId, { type: 'room:hostChanged', payload: targetId });
    void this.prisma.room
      .update({ where: { id: roomId }, data: { hostPlayerId: targetId } })
      .catch(err => this.logger.error('Failed to persist host transfer', err instanceof Error ? err.message : String(err)));
    return true;
  }

  isMuted(roomId: string, playerId: string): boolean {
    return this.rooms.get(roomId)?.players.get(playerId)?.isMuted ?? false;
  }

  private isTeammate(room: RoomState, a: string, b: string): boolean {
    if (room.settings.mode !== 'TEAM' || !room.teams) return false;
    return (
      (room.teams.teamA.includes(a) && room.teams.teamA.includes(b)) ||
      (room.teams.teamB.includes(a) && room.teams.teamB.includes(b))
    );
  }

  private emit(roomId: string, event: RoomEvent) {
    const sink = this.sinks.get(roomId);
    if (sink) sink(event);
  }

  private emitScores(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const scores = Array.from(room.players.values()).map(p => ({
      playerId: p.id,
      points: p.score,
      delta: 0,
    }));
    this.emit(roomId, { type: 'score:updated', payload: scores });
  }

  private toPlayerInfo(p: PlayerState): PlayerInfo {
    return {
      id: p.id,
      nickname: p.nickname,
      avatar: p.avatar,
      isHost: p.isHost,
      isReady: p.isReady,
      isOnline: p.isOnline,
      score: p.score,
      isMuted: p.isMuted,
      isKicked: p.isKicked,
    };
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
