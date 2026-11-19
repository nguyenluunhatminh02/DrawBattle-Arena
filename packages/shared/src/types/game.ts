export type GamePhase = 'WAITING' | 'WORD_PICK' | 'DRAWING' | 'REVEAL' | 'NEXT_TURN' | 'MATCH_RESULT';

export type WordDifficulty = 'EASY' | 'MEDIUM' | 'HARD';

export type GameMode = 'CLASSIC' | 'DUEL' | 'SPEED' | 'TEAM';

export type RoomStatus = 'WAITING' | 'PLAYING' | 'FINISHED';

export type PlayerRole = 'HOST' | 'PLAYER' | 'SPECTATOR';

export type MatchStatus = 'IN_PROGRESS' | 'FINISHED' | 'CANCELLED';

export type TurnStatus = 'WORD_PICK' | 'DRAWING' | 'REVEAL' | 'NEXT_TURN' | 'FINISHED';

export interface WordOption {
  id: string;
  canonical: string;
  difficulty: WordDifficulty;
  category: string;
}

export interface PlayerInfo {
  id: string;
  nickname: string;
  avatar?: string;
  isHost: boolean;
  isReady: boolean;
  isOnline: boolean;
  score: number;
  isMuted?: boolean;
  isKicked?: boolean;
}

export interface RoomSettings {
  maxPlayers: number;
  rounds: number;
  turnDuration: number;
  difficulty: WordDifficulty | 'MIXED';
  language: string;
  category?: string;
  enableHints: boolean;
  enableGuests: boolean;
  password?: string;
  mode: GameMode;
}

export interface RoomSnapshot {
  id: string;
  code: string;
  hostId: string;
  yourPlayerId?: string;
  hasPassword?: boolean;
  players: PlayerInfo[];
  settings: RoomSettings;
  status: RoomStatus;
  currentMatch?: MatchSnapshot;
}

export interface MatchSnapshot {
  id: string;
  currentRound: number;
  totalRounds: number;
  currentTurn?: TurnSnapshot;
  scores: Array<{ playerId: string; points: number }>;
}

export interface TurnSnapshot {
  id: string;
  drawerId: string;
  phase: GamePhase;
  endsAt: number;
  strokes: StrokeChunk[];
}

export interface StrokePoint {
  x: number;
  y: number;
}

export interface StrokeChunk {
  turnId: string;
  strokeId: string;
  seq: number;
  points: StrokePoint[];
  color: string;
  width: number;
}

export interface ScoreUpdate {
  playerId: string;
  points: number;
  delta: number;
}

export interface PhaseData {
  turnId?: string;
  drawerId?: string;
  endsAt?: number;
  word?: string;
  words?: WordOption[];
  correctGuessers?: string[];
  hint?: string;
}

export interface TeamMember {
  id: string;
  nickname: string;
}

export interface TeamsPayload {
  teamA: TeamMember[];
  teamB: TeamMember[];
}

export interface TeamResult {
  name: 'A' | 'B';
  members: TeamMember[];
  points: number;
}

export interface TeamResults {
  teamA: TeamResult;
  teamB: TeamResult;
  winner: 'A' | 'B' | 'DRAW';
}

export interface MatchResult {
  matchId: string;
  rankings: Array<{
    playerId: string;
    nickname: string;
    points: number;
    rank: number;
  }>;
  duration: number;
  teams?: TeamResults;
}

export interface ChatMessage {
  id: string;
  playerId: string;
  nickname: string;
  message: string;
  isGuess: boolean;
  isCorrect: boolean;
  timestamp: number;
}
