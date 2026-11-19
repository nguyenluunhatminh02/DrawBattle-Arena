import type { WordDifficulty } from './types/game';

export const GAME_CONSTANTS = {
  DEFAULT_TURN_DURATION: 60,
  WORD_PICK_DURATION: 10,
  REVEAL_DURATION: 5,
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 8,
  MAX_GUESSES_PER_TURN: 20,
  GUESS_RATE_LIMIT_MS: 500,
  CHAT_RATE_LIMIT_MS: 1000,
  STROKE_BATCH_MS: 50,
  RECONNECT_GRACE_MS: 15000,
  ROOM_TTL_MS: 2 * 60 * 60 * 1000,
  CHALLENGE_TTL_MS: 24 * 60 * 60 * 1000,
  MAX_CHALLENGE_ATTEMPTS: 3,
  CHALLENGE_DRAW_TIME: 15,
  HINT_FIRST_PERCENT: 40,
  HINT_SECOND_PERCENT: 70,
  MAX_STROKES_PER_TURN: 500,
  MAX_POINTS_PER_STROKE: 2000,
  MAX_STROKE_PAYLOAD_BYTES: 65536,
  SPEED_TURN_DURATION: 30,
  SPEED_WORD_PICK_DURATION: 5,
  SPEED_REVEAL_DURATION: 3,
  DUEL_ROUNDS: 3,
  DUEL_TURN_DURATION: 45,
  TEAM_MIN_PLAYERS: 4,
} as const;

export const GAME_MODE_LABELS: Record<string, string> = {
  CLASSIC: 'Cổ điển',
  DUEL: '1v1 Duel',
  SPEED: 'Speed Round',
  TEAM: 'Đội chiến',
};

export interface ModeConfig {
  turnDuration: number;
  wordPickDuration: number;
  revealDuration: number;
  maxPlayers: number;
  minPlayers: number;
  rounds: number;
}

export function getModeConfig(mode: string): ModeConfig {
  switch (mode) {
    case 'SPEED':
      return {
        turnDuration: GAME_CONSTANTS.SPEED_TURN_DURATION,
        wordPickDuration: GAME_CONSTANTS.SPEED_WORD_PICK_DURATION,
        revealDuration: GAME_CONSTANTS.SPEED_REVEAL_DURATION,
        maxPlayers: 8,
        minPlayers: GAME_CONSTANTS.MIN_PLAYERS,
        rounds: 2,
      };
    case 'DUEL':
      return {
        turnDuration: GAME_CONSTANTS.DUEL_TURN_DURATION,
        wordPickDuration: GAME_CONSTANTS.WORD_PICK_DURATION,
        revealDuration: GAME_CONSTANTS.REVEAL_DURATION,
        maxPlayers: 2,
        minPlayers: 2,
        rounds: GAME_CONSTANTS.DUEL_ROUNDS,
      };
    case 'TEAM':
      return {
        turnDuration: GAME_CONSTANTS.DEFAULT_TURN_DURATION,
        wordPickDuration: GAME_CONSTANTS.WORD_PICK_DURATION,
        revealDuration: GAME_CONSTANTS.REVEAL_DURATION,
        maxPlayers: 8,
        minPlayers: GAME_CONSTANTS.TEAM_MIN_PLAYERS,
        rounds: 2,
      };
    default:
      return {
        turnDuration: GAME_CONSTANTS.DEFAULT_TURN_DURATION,
        wordPickDuration: GAME_CONSTANTS.WORD_PICK_DURATION,
        revealDuration: GAME_CONSTANTS.REVEAL_DURATION,
        maxPlayers: GAME_CONSTANTS.MAX_PLAYERS,
        minPlayers: GAME_CONSTANTS.MIN_PLAYERS,
        rounds: 2,
      };
  }
}

export function calculateGuesserScore(
  turnDuration: number,
  remainingTime: number,
  isFirstCorrect: boolean,
  _usedHint: boolean,
): number {
  const baseScore = 60 + Math.floor(100 * remainingTime / turnDuration);
  const firstBonus = isFirstCorrect ? 20 : 0;
  return Math.min(baseScore + firstBonus, 160);
}

export function calculateDrawerScore(correctGuessers: number): number {
  return Math.min(correctGuessers * 20, 100);
}

export function normalizeGuess(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .normalize('NFC')
    .replace(/\s+/g, ' ');
}

export function validateGuess(
  guess: string,
  answer: string,
  synonyms: string[],
): boolean {
  const normalizedGuess = normalizeGuess(guess);
  if (normalizedGuess === normalizeGuess(answer)) return true;
  return synonyms.some(s => normalizeGuess(s) === normalizedGuess);
}

export function generateHint(
  word: string,
  phase: 'first' | 'second',
): string {
  const chars = [...word];
  if (phase === 'first') {
    return chars.map(c => c === ' ' ? ' ' : '_').join('');
  }
  const nonSpaceIndices = chars
    .map((c, i) => c !== ' ' ? i : -1)
    .filter(i => i !== -1);
  const revealCount = Math.max(1, Math.floor(nonSpaceIndices.length * 0.3));
  const available = [...nonSpaceIndices];
  const revealed = new Set<number>();
  for (let i = 0; i < revealCount && available.length > 0; i++) {
    const pick = Math.floor(Math.random() * available.length);
    revealed.add(available[pick]);
    available.splice(pick, 1);
  }
  return chars.map((c, i) => {
    if (c === ' ') return ' ';
    if (revealed.has(i)) return c;
    return '_';
  }).join('');
}

export function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function pickWordOptions<T>(words: T[], count: number = 3): T[] {
  return shuffleArray(words).slice(0, count);
}

export function validateStrokeCoordinates(
  points: Array<{ x: number; y: number }>,
): boolean {
  return points.every(p =>
    typeof p.x === 'number' && typeof p.y === 'number' &&
    p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 &&
    isFinite(p.x) && isFinite(p.y)
  );
}

export const DIFFICULTY_LABELS: Record<WordDifficulty, string> = {
  EASY: 'Dễ',
  MEDIUM: 'Trung bình',
  HARD: 'Khó',
};
