import { z } from 'zod';

export const nicknameSchema = z.string()
  .min(1, 'Nickname is required')
  .max(20, 'Nickname must be 20 characters or less')
  .regex(/^[\p{L}\p{N}\s_-]+$/u, 'Invalid characters in nickname');

export const roomCodeSchema = z.string()
  .length(6, 'Room code must be 6 characters')
  .regex(/^[A-Z0-9]+$/, 'Invalid room code format');

export const guessSchema = z.string()
  .min(1, 'Guess cannot be empty')
  .max(100, 'Guess too long');

export const chatMessageSchema = z.string()
  .min(1, 'Message cannot be empty')
  .max(200, 'Message too long');

export const strokePointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export const strokeChunkSchema = z.object({
  turnId: z.string().min(1),
  strokeId: z.string().min(1),
  seq: z.number().int().min(0),
  points: z.array(strokePointSchema).min(1).max(2000),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  width: z.number().min(1).max(20),
});

export const roomSettingsSchema = z.object({
  maxPlayers: z.number().int().min(2).max(8).default(8),
  rounds: z.number().int().min(1).max(3).default(2),
  turnDuration: z.enum(['45', '60', '90']).default('60'),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD', 'MIXED']).default('MIXED'),
  language: z.string().default('vi'),
  category: z.string().optional(),
  enableHints: z.boolean().default(true),
  enableGuests: z.boolean().default(true),
  password: z.string().max(20).optional(),
  mode: z.enum(['CLASSIC', 'DUEL', 'SPEED', 'TEAM']).default('CLASSIC'),
});

export const createRoomSchema = z.object({
  nickname: nicknameSchema,
  settings: roomSettingsSchema.optional(),
});

export const joinRoomSchema = z.object({
  nickname: nicknameSchema,
  password: z.string().max(20).optional(),
});

export const createChallengeSchema = z.object({
  category: z.string().optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
});

export const finalizeChallengeSchema = z.object({
  strokes: z.array(z.object({
    strokeId: z.string(),
    points: z.array(strokePointSchema),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    width: z.number().min(1).max(20),
  })).max(500),
  durationMs: z.number().int().min(1000).max(30000),
});

export const submitGuessSchema = z.object({
  answer: guessSchema,
});
