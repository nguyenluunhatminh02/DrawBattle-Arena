export interface GuestSessionResponse {
  token: string;
  playerId: string;
  expiresAt: string;
}

export interface CreateRoomRequest {
  nickname: string;
  settings?: {
    maxPlayers?: number;
    rounds?: number;
    turnDuration?: number;
    difficulty?: string;
    category?: string;
    enableHints?: boolean;
    enableGuests?: boolean;
    password?: string;
  };
}

export interface CreateRoomResponse {
  roomId: string;
  roomCode: string;
  joinUrl: string;
}

export interface JoinRoomRequest {
  nickname: string;
  password?: string;
}

export interface JoinRoomResponse {
  roomId: string;
  roomCode: string;
  playerId: string;
  joinToken: string;
}

export interface RoomInfoResponse {
  code: string;
  status: string;
  playerCount: number;
  maxPlayers: number;
  hasPassword: boolean;
  settings: Record<string, unknown>;
}

export interface CreateChallengeRequest {
  category?: string;
  difficulty?: string;
}

export interface CreateChallengeResponse {
  challengeId: string;
  word: string;
  timeLimit: number;
}

export interface FinalizeChallengeRequest {
  strokes: Array<{
    strokeId: string;
    points: Array<{ x: number; y: number }>;
    color: string;
    width: number;
  }>;
  durationMs: number;
}

export interface ChallengeInfoResponse {
  challengeId: string;
  status: string;
  expiresAt: string;
  hasReplay: boolean;
  attemptCount: number;
  maxAttempts: number;
}

export interface SubmitGuessRequest {
  answer: string;
}

export interface SubmitGuessResponse {
  correct: boolean;
  attemptNo: number;
  remainingAttempts: number;
  answer?: string;
}
