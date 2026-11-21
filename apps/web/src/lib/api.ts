const BASE = '/api';
const DEFAULT_TIMEOUT_MS = 15_000;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const merged = new Headers({ 'Content-Type': 'application/json' });
  if (options?.headers) {
    const h = options.headers;
    if (h instanceof Headers) {
      h.forEach((v, k) => merged.set(k, v));
    } else if (Array.isArray(h)) {
      h.forEach(([k, v]) => merged.set(k, v));
    } else {
      for (const [k, v] of Object.entries(h as Record<string, string>)) {
        merged.set(k, String(v));
      }
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: merged,
      signal: options?.signal ?? ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText }));
      // Nest ValidationPipe returns an array of messages; render every one so
      // the player sees exactly why a guess or payload was rejected.
      const message = Array.isArray(body.message)
        ? body.message.join('; ')
        : body.message || `HTTP ${res.status}`;
      throw new Error(message);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
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
    token?: string,
  ) {
    return request<{ ok: boolean }>(`/challenges/${challengeId}/finalize`, {
      method: 'POST',
      headers: token ? authed(token) : undefined,
      body: JSON.stringify({ strokes, durationMs }),
    });
  },

  getChallengeInfo(id: string, token?: string) {
    return request<{
      challengeId: string;
      status: string;
      expiresAt: string;
      hasReplay: boolean;
      replay: { strokes: unknown; durationMs: number } | null;
      attemptCount: number;
      myAttempts: number;
      mySolved: boolean;
      answerCanonical?: string;
      maxAttempts: number;
    }>(`/challenges/${id}`, { headers: token ? authed(token) : undefined });
  },

  getDailyToday(token?: string) {
    return request<{
      id: string;
      date: string;
      word: { id: string; difficulty: string; category?: { name: string } };
      hasReplay: boolean;
      replay: { strokes: Array<{ strokeId: string; points: Array<{ x: number; y: number }>; color: string; width: number }>; durationMs: number } | null;
      answerCanonical?: string;
      userAttempt: { id: string; correct: boolean; answer: string } | null;
      stats: { totalAttempts: number; correctAttempts: number; successRate: number };
    }>('/daily/today', { headers: token ? authed(token) : undefined });
  },

  submitDailyAnswer(challengeId: string, answer: string, token?: string) {
    return request<{
      attempt: { id: string; correct: boolean };
      correct: boolean;
      remainingAttempts: number;
      answerCanonical?: string;
    }>('/daily/submit', {
      method: 'POST',
      headers: token ? authed(token) : undefined,
      body: JSON.stringify({ challengeId, answer }),
    });
  },

  submitChallengeGuess(id: string, answer: string, token?: string) {
    return request<{
      correct: boolean;
      attemptNo: number;
      remainingAttempts: number;
      answer?: string;
    }>(`/challenges/${id}/guesses`, {
      method: 'POST',
      headers: token ? authed(token) : undefined,
      body: JSON.stringify({ answer }),
    });
  },

  /** Queue a replay render with the same auth/share context as read endpoints. */
  queueReplayRender(
    replayId: string,
    options?: { token?: string; share?: string },
  ) {
    const headers: Record<string, string> = {};
    if (options?.token) headers.Authorization = `Bearer ${options.token}`;
    if (options?.share) headers['X-Share-Token'] = options.share;
    return request<{ jobId: string; status: string }>(
      `/replays/${encodeURIComponent(replayId)}/render`,
      { method: 'POST', headers },
    );
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
