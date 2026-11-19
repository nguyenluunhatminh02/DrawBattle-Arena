const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message || `HTTP ${res.status}`);
  }
  return res.json();
}

function authed(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

export const api = {
  createGuest(nickname: string) {
    return request<{ token: string; playerId: string; expiresAt: string }>(
      '/guest-sessions',
      { method: 'POST', body: JSON.stringify({ nickname }) },
    );
  },

  createRoom(token: string, settings?: Record<string, unknown>) {
    return request<{ roomId: string; roomCode: string }>(
      '/rooms',
      { method: 'POST', headers: authed(token), body: JSON.stringify({ settings }) },
    );
  },

  getRoomInfo(code: string) {
    return request<{
      code: string;
      status: string;
      playerCount: number;
      maxPlayers: number;
      hasPassword: boolean;
    }>(`/rooms/${code}`);
  },

  joinRoom(token: string, code: string, password?: string) {
    return request<{ roomId: string; roomCode: string; playerId: string }>(
      `/rooms/${code}/join`,
      { method: 'POST', headers: authed(token), body: JSON.stringify({ password }) },
    );
  },

  createChallenge(token: string, options?: { difficulty?: string; category?: string; wordId?: string }) {
    return request<{ challengeId: string; word: string; timeLimit: number }>(
      '/challenges',
      { method: 'POST', headers: authed(token), body: JSON.stringify(options) },
    );
  },

  finalizeChallenge(
    challengeId: string,
    strokes: Array<{ strokeId: string; points: Array<{ x: number; y: number }>; color: string; width: number }>,
    durationMs: number,
  ) {
    return request<{ ok: boolean }>(`/challenges/${challengeId}/finalize`, {
      method: 'POST',
      body: JSON.stringify({ strokes, durationMs }),
    });
  },

  getChallengeInfo(id: string) {
    return request<{
      challengeId: string;
      status: string;
      expiresAt: string;
      hasReplay: boolean;
      replay: { strokes: unknown; durationMs: number } | null;
      attemptCount: number;
      maxAttempts: number;
    }>(`/challenges/${id}`);
  },

  submitChallengeGuess(id: string, answer: string, solverId?: string) {
    return request<{
      correct: boolean;
      attemptNo: number;
      remainingAttempts: number;
      answer?: string;
    }>(`/challenges/${id}/guesses`, {
      method: 'POST',
      body: JSON.stringify({ answer, solverId }),
    });
  },

  getMatchResults(id: string) {
    return request<{
      matchId: string;
      roomCode: string;
      rankings: Array<{ playerId: string; nickname: string; points: number; rank: number }>;
      duration: number;
    }>(`/matches/${id}/results`);
  },

  getMyMatches(token: string) {
    return request<{ matches: Array<{ id: string; roomCode: string; rankings: unknown[] }> }>(
      '/matches/me',
      { headers: authed(token) },
    );
  },

  getLeaderboard(period: string = 'all-time', limit: number = 50) {
    return request<{
      period: string;
      entries: Array<{ rank: number; playerId: string; nickname: string; points: number }>;
    }>(`/leaderboards?period=${period}&limit=${limit}`);
  },

  updateReport(token: string, id: string, status: string, action?: string) {
    return request<unknown>(`/reports/${id}`, {
      method: 'PATCH',
      headers: authed(token),
      body: JSON.stringify({ status, action }),
    });
  },
};
