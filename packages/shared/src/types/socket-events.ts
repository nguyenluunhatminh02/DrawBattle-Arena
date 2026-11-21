import type { StrokeChunk, WordOption, PlayerInfo, RoomSnapshot, MatchResult, ScoreUpdate, PhaseData, ChatMessage, GamePhase, TurnSnapshot, TeamsPayload } from './game';

export interface ClientToServerEvents {
  'room:join': (data: { roomCode: string; token: string; nickname?: string; password?: string }) => void;
  'room:leave': () => void;
  'room:ready': (ready: boolean) => void;
  'match:start': () => void;
  'match:rematch': () => void;
  'turn:chooseWord': (wordId: string) => void;
  'draw:strokeStart': (data: { turnId: string; strokeId: string }) => void;
  'draw:strokeChunk': (data: StrokeChunk) => void;
  'draw:strokeEnd': (data: { turnId: string; strokeId: string }) => void;
  'draw:clear': () => void;
  'draw:undo': () => void;
  'guess:submit': (guess: string) => void;
  'chat:send': (message: string) => void;
  'room:hostAction': (data: { action: 'kick' | 'mute' | 'transferHost'; targetId: string }) => void;
  'room:updateSettings': (data: { rounds?: number; turnDuration?: number; enableHints?: boolean; difficulty?: string; category?: string }) => void;
  'state:resync': () => void;
}

export interface ServerToClientEvents {
  'room:snapshot': (snapshot: RoomSnapshot) => void;
  'room:playerJoined': (player: PlayerInfo) => void;
  'room:playerLeft': (playerId: string) => void;
  'room:left': () => void;
  'room:hostChanged': (newHostId: string) => void;
  'room:playerKicked': (data: { playerId: string }) => void;
  'room:kicked': (data: { roomCode?: string }) => void;
  'room:playerMuted': (data: { playerId: string; muted: boolean }) => void;
  /** Sent to a socket whose player slot was taken over by a newer socket. */
  'session:replaced': (data: { roomId: string }) => void;
  'match:started': (data: { matchId: string; round: number; totalRounds: number; drawerOrder?: Array<{ id: string; nickname: string }> }) => void;
  'match:teams': (data: TeamsPayload) => void;
  'match:cancelled': (data: { reason: string }) => void;
  'match:phaseChanged': (data: PhaseData & { phase: GamePhase }) => void;
  'turn:youAreDrawer': (data: { turnId: string; words: WordOption[]; timeLimit: number }) => void;
  'turn:publicState': (data: { turnId: string; drawerId: string; timeLimit: number }) => void;
  'turn:yourWord': (data: { word: string }) => void;
  'turn:hint': (data: { hint: string }) => void;
  'turn:restore': (snapshot: TurnSnapshot) => void;
  'draw:chunk': (chunk: StrokeChunk) => void;
  'draw:reset': () => void;
  'draw:undo': (strokeId: string) => void;
  'guess:accepted': (data: { playerId: string }) => void;
  'guess:correct': (data: { playerId: string; score: number }) => void;
  'guess:wrong': () => void;
  'score:updated': (scores: ScoreUpdate[]) => void;
  'turn:revealed': (data: { word: string; correctGuessers: string[]; drawerScore: number }) => void;
  'match:finished': (results: MatchResult) => void;
  'chat:message': (message: ChatMessage) => void;
  'error': (code: string, message: string) => void;
}
