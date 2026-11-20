import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PlayerInfo, RoomSettings, StrokeChunk, ChatMessage, GamePhase, ScoreUpdate } from '@drawbattle/shared';

interface Player {
  token: string;
  playerId: string;
  nickname: string;
  avatar?: string;
}

interface User {
  id: string;
  email: string;
  nickname: string;
}

interface GameStore {
  player: Player | null;
  setPlayer: (p: Player | null) => void;
  user: User | null;
  setUser: (u: User | null) => void;
  token: string | null;
  setToken: (t: string | null) => void;

  myPlayerId: string | null;
  setMyPlayerId: (id: string | null) => void;

  room: {
    code: string;
    hostId: string;
    players: PlayerInfo[];
    settings: RoomSettings;
    status: string;
  } | null;
  setRoom: (room: GameStore['room'] | ((prev: GameStore['room']) => GameStore['room'])) => void;

  currentPhase: GamePhase | null;
  setPhase: (phase: GamePhase | null) => void;

  drawerId: string | null;
  setDrawerId: (id: string | null) => void;

  wordOptions: Array<{ id: string; canonical: string; difficulty: string; category: string }>;
  setWordOptions: (words: GameStore['wordOptions']) => void;

  currentWord: string | null;
  setCurrentWord: (word: string | null) => void;

  turnEndsAt: number | null;
  setTurnEndsAt: (t: number | null) => void;

  currentTurnId: string | null;
  setCurrentTurnId: (id: string | null) => void;

  strokes: StrokeChunk[];
  addStroke: (chunk: StrokeChunk) => void;
  setStrokes: (strokes: StrokeChunk[]) => void;
  clearStrokes: () => void;

  scores: ScoreUpdate[];
  setScores: (scores: ScoreUpdate[]) => void;

  chat: ChatMessage[];
  addChat: (msg: ChatMessage) => void;
  clearChat: () => void;

  hint: string | null;
  setHint: (h: string | null) => void;

  isDrawer: () => boolean;
  myScore: () => number;
}

export const useGameStore = create<GameStore>()(
  persist(
    (set, get) => ({
      player: null,
      setPlayer: p => set({ player: p }),
      user: null,
      setUser: u => set({ user: u }),
      token: null,
      setToken: t => set({ token: t }),

      myPlayerId: null,
      setMyPlayerId: id => set({ myPlayerId: id }),

      room: null,
      setRoom: room => {
        if (typeof room === 'function') {
          set(state => ({ room: room(state.room) }));
        } else {
          set({ room });
        }
      },

      currentPhase: null,
      setPhase: phase => set({ currentPhase: phase }),

      drawerId: null,
      setDrawerId: id => set({ drawerId: id }),

      wordOptions: [],
      setWordOptions: words => set({ wordOptions: words }),

      currentWord: null,
      setCurrentWord: word => set({ currentWord: word }),

      turnEndsAt: null,
      setTurnEndsAt: t => set({ turnEndsAt: t }),

      currentTurnId: null,
      setCurrentTurnId: id => set({ currentTurnId: id }),

      strokes: [],
      addStroke: chunk =>
        set(s => {
          const idx = s.strokes.findIndex(x => x.strokeId === chunk.strokeId);
          if (idx < 0) return { strokes: [...s.strokes, chunk] };
          const prev = s.strokes[idx];
          if (chunk.seq <= prev.seq) return {};
          const next = [...s.strokes];
          next[idx] = { ...prev, seq: chunk.seq, points: [...prev.points, ...chunk.points] };
          return { strokes: next };
        }),
      setStrokes: strokes => set({ strokes }),
      clearStrokes: () => set({ strokes: [] }),

      scores: [],
      setScores: scores => set({ scores }),

      chat: [],
      addChat: msg => set(s => ({ chat: [...s.chat.slice(-50), msg] })),
      clearChat: () => set({ chat: [] }),

      hint: null,
      setHint: h => set({ hint: h }),

      isDrawer: () => {
        const { myPlayerId, drawerId } = get();
        return !!myPlayerId && myPlayerId === drawerId;
      },

      myScore: () => {
        const { myPlayerId, scores } = get();
        if (!myPlayerId) return 0;
        const mine = scores.find(s => s.playerId === myPlayerId);
        return mine?.points ?? 0;
      },
    }),
    {
      name: 'drawbattle-store',
      partialize: state => ({ player: state.player, token: state.token, user: state.user }),
    },
  ),
);
