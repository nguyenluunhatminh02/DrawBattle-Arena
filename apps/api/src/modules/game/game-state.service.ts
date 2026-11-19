import { Injectable, Logger } from '@nestjs/common';
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
import { censorProfanity } from '../../common/profanity';

interface RoomState {
  roomId: string;
  hostId: string;
  players: Map<string, PlayerState>;
  settings: RoomSettings;
  match: MatchState | null;
  teams?: { teamA: string[]; teamB: string[] };
}

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

interface CompletedTurn {
  id: string;
  drawerId: string;
  wordId: string;
  strokes: StrokeChunk[];
  startedAt: number;
  endsAt: number;
  correctCount: number;
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

@Injectable()
export class GameStateService {
  private readonly logger = new Logger(GameStateService.name);
  private readonly rooms = new Map<string, RoomState>();
  private readonly sinks = new Map<string, EventSink>();

  constructor(
    private readonly wordService: WordService,
    private readonly prisma: PrismaService,
    private readonly featureFlags: FeatureFlagService,
  ) {}

  registerSink(roomId: string, sink: EventSink) {
    this.sinks.set(roomId, sink);
  }

  unregisterSink(roomId: string) {
    this.sinks.delete(roomId);
  }

  initRoom(
    roomId: string,
    hostId: string,
    hostNickname: string,
    settings: RoomSettings,
  ) {
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
    });
  }

  addPlayer(roomId: string, id: string, nickname: string): PlayerInfo | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    if (room.players.size >= room.settings.maxPlayers) return null;
    if (room.players.has(id)) {
      const p = room.players.get(id)!;
      p.isOnline = true;
      return this.toPlayerInfo(p);
    }
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
    room.players.delete(playerId);
    if (room.players.size === 0) {
      this.rooms.delete(roomId);
      return null;
    }
    if (room.hostId === playerId) {
      const newHost = room.players.values().next().value as PlayerState;
      newHost.isHost = true;
      room.hostId = newHost.id;
      this.emit(roomId, { type: 'room:hostChanged', payload: newHost.id });
      return newHost.id;
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
    const { password, ...safeSettings } = room.settings;
    return {
      id: room.roomId,
      code: '',
      hostId: room.hostId,
      hasPassword: Boolean(password),
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

  async startMatch(roomId: string): Promise<boolean> {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    const modeConfig = getModeConfig(room.settings.mode || 'CLASSIC');
    const eligible = Array.from(room.players.values()).filter(p => !p.isKicked);
    if (eligible.length < modeConfig.minPlayers) return false;
    if (room.match) return false;

    void this.prisma.room
      .update({ where: { id: roomId }, data: { status: 'PLAYING' } })
      .catch(() => undefined);

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
    const matchId = uuid();
    const rounds = room.settings.mode === 'DUEL' ? modeConfig.rounds : room.settings.rounds;
    const totalTurns =
      room.settings.mode === 'DUEL'
        ? modeConfig.rounds
        : rounds * drawerOrder.length;
    room.match = {
      id: matchId,
      rounds,
      totalTurns,
      currentRound: 1,
      drawerOrder,
      currentDrawerIndex: 0,
      turn: null,
      completedTurns: [],
      turnDuration,
      enableHints,
    };

    for (const p of room.players.values()) {
      p.score = 0;
    }

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
        payload: {
          teamA: toMembers(room.teams.teamA),
          teamB: toMembers(room.teams.teamB),
        },
      });
    } else {
      room.teams = undefined;
    }

    this.emit(roomId, {
      type: 'match:started',
      payload: { matchId, round: 1, totalRounds: rounds, drawerOrder: drawerOrder.map(id => ({ id, nickname: room.players.get(id)?.nickname || '?' })) },
    });

    await this.startWordPickPhase(roomId);
    return true;
  }

  private async startWordPickPhase(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room || !room.match) {
      return;
    }

    const drawerId =
      room.match.drawerOrder[
        room.match.currentDrawerIndex % room.match.drawerOrder.length
      ];
    const options = await this.wordService.pickRandomWords(3, {
      difficulty: room.settings.difficulty,
      category: room.settings.category,
    });

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

    const autoSelectTimer = setTimeout(async () => {
      const current = this.rooms.get(roomId)?.match?.turn;
      if (current && current.phase === 'WORD_PICK' && !current.wordId && current.wordOptions[0]) {
        await this.chooseWord(roomId, drawerId, current.wordOptions[0].id);
      }
    }, wordPickDuration * 1000);

    room.match.turn.timer = autoSelectTimer;
  }

  async chooseWord(roomId: string, playerId: string, wordId: string): Promise<boolean> {
    const room = this.rooms.get(roomId);
    const turn = room?.match?.turn;
    if (!room || !turn || turn.phase !== 'WORD_PICK') return false;
    if (turn.drawerId !== playerId) return false;
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
          this.emit(roomId, {
            type: 'turn:hint',
            payload: { hint: generateHint(turn.word!, 'first') },
          });
        }
      }, firstHintAt);
      const secondTimer = setTimeout(() => {
        if (turn.phase === 'DRAWING') {
          turn.hintPhase = 'second';
          this.emit(roomId, {
            type: 'turn:hint',
            payload: { hint: generateHint(turn.word!, 'second') },
          });
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
    return (
      !!room &&
      !!turn &&
      turn.phase === 'DRAWING' &&
      turn.drawerId === playerId &&
      turn.id === turnId
    );
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
      if (existing.points.length + chunk.points.length > GAME_CONSTANTS.MAX_POINTS_PER_STROKE) {
        return false;
      }
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
  ): Promise<boolean> {
    const room = this.rooms.get(roomId);
    if (!room || room.hostId !== hostId || room.match) return false;

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
    room.settings = next;

    try {
      await this.prisma.room.update({
        where: { id: roomId },
        data: { settings: next as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      this.logger.error(
        `Failed to persist settings for room ${roomId}`,
        err instanceof Error ? err.message : String(err),
      );
    }

    this.emit(roomId, { type: 'room:snapshot', payload: this.getSnapshot(roomId) });
    return true;
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

    if (!turn.word) return { accepted: true, correct: false };

    const correct = validateGuess(guess, turn.word, turn.synonyms);
    if (correct) {
      player.hasCorrectGuess = true;
      turn.correctGuessers.add(playerId);
      if (!turn.firstCorrectId) turn.firstCorrectId = playerId;

      const remaining = Math.max(0, Math.floor((turn.endsAt - now) / 1000));
      const isFirst = turn.correctGuessers.size === 1;
      const score = calculateGuesserScore(
        turn.timeLimit,
        remaining,
        isFirst,
        player.usedHint,
      );
      player.score += score;

      this.emit(roomId, {
        type: 'guess:correct',
        payload: { playerId, score },
      });
      this.emitScores(roomId);

const eligibleGuessers = Array.from(room.players.values()).filter(
        p => p.id !== turn.drawerId && p.isOnline && !this.isTeammate(room, turn.drawerId, p.id),
      );
      if (turn.correctGuessers.size >= eligibleGuessers.length) {
        if (turn.timer) clearTimeout(turn.timer);
        setTimeout(() => void this.endTurn(roomId), 1500);
      }

      return { accepted: true, correct: true, score };
    }

    this.emit(roomId, {
      type: 'guess:accepted',
      payload: { playerId },
      targetId: playerId,
    });
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

  private async endTurn(roomId: string) {
    const room = this.rooms.get(roomId);
    const turn = room?.match?.turn;
    if (!room || !turn) return;
    if (turn.ended) {
      return;
    }
    if (turn.phase === 'REVEAL' || turn.phase === 'MATCH_RESULT') {
      return;
    }

    turn.ended = true;
    if (turn.timer) clearTimeout(turn.timer);
    for (const t of turn.hintTimers) clearTimeout(t);
    turn.timer = null;
    turn.hintTimers = [];
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

    if (
      completedTurns % room.match.drawerOrder.length === 0 &&
      completedTurns > 0
    ) {
      room.match.currentRound++;
    }

    this.emit(roomId, {
      type: 'match:phaseChanged',
      payload: { phase: 'NEXT_TURN' },
    });

    setTimeout(() => {
      void this.startWordPickPhase(roomId);
    }, 2000);
  }



  private async endMatch(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room || !room.match) return;

    const rankings = Array.from(room.players.values())
      .map(p => ({
        playerId: p.id,
        nickname: p.nickname,
        points: p.score,
        rank: 0,
      }))
      .sort((a, b) => b.points - a.points)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    const matchId = room.match.id;
    const duration = Date.now() - (room.match.turn?.startedAt ?? Date.now());

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
        winner:
          teamA.points === teamB.points ? 'DRAW' : teamA.points > teamB.points ? 'A' : 'B',
      };
    }

    this.emit(roomId, {
      type: 'match:finished',
      payload: { matchId, rankings, duration, ...(teamsResult ? { teams: teamsResult } : {}) },
    });

    try {
      const completed = room.match.completedTurns;
      const turnsPerRound = Math.max(1, room.match.drawerOrder.length);
      const roundCount = Math.max(1, Math.ceil(completed.length / turnsPerRound));
      const dbMatch = await this.prisma.match.create({
        data: {
          id: matchId,
          roomId,
          status: 'FINISHED',
          rules: room.settings as unknown as Prisma.InputJsonValue,
          endedAt: new Date(),
          scores: {
            create: rankings.map(r => ({
              playerId: r.playerId,
              points: r.points,
            })),
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
                  })),
              },
            })),
          },
        },
      });
      this.logger.log(`Match ${dbMatch.id} persisted: ${rankings.length} scores, ${completed.length} replays`);
    } catch (err) {
      this.logger.error(`Failed to persist match ${matchId}`, err instanceof Error ? err.message : String(err));
    }

    room.match = null;
    void this.prisma.room
      .update({ where: { id: roomId }, data: { status: 'WAITING' } })
      .catch(() => undefined);
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
    this.emit(roomId, {
      type: 'room:playerKicked',
      payload: { playerId: targetId },
      targetId,
    });
    this.removePlayer(roomId, targetId);
    return true;
  }

  mutePlayer(roomId: string, hostId: string, targetId: string, muted: boolean): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.hostId !== hostId || hostId === targetId) return false;
    const target = room.players.get(targetId);
    if (!target) return false;
    target.isMuted = muted;
    this.emit(roomId, {
      type: 'room:playerMuted',
      payload: { playerId: targetId, muted },
    });
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
