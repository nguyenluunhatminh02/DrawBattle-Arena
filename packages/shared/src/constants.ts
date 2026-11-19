export const COLORS = [
  '#000000',
  '#FFFFFF',
  '#EF4444',
  '#F97316',
  '#EAB308',
  '#22C55E',
  '#3B82F6',
  '#8B5CF6',
  '#EC4899',
  '#6B7280',
  '#92400E',
  '#06B6D4',
] as const;

export const BRUSH_SIZES = [3, 6, 10, 16] as const;

export const WORD_CATEGORIES = [
  { slug: 'animals', name: 'Động vật' },
  { slug: 'food', name: 'Đồ ăn' },
            { slug: 'household', name: 'Đồ gia dụng' },
            { slug: 'jobs', name: 'Nghề nghiệp' },
  { slug: 'vehicles', name: 'Phương tiện' },
  { slug: 'places', name: 'Địa điểm' },
  { slug: 'activities', name: 'Hoạt động' },
  { slug: 'tech', name: 'Công nghệ' },
  { slug: 'school', name: 'Trường học' },
  { slug: 'nature', name: 'Thiên nhiên' },
] as const;

export const CANVAS_ASPECT_RATIO = 16 / 10;

export const ERROR_CODES = {
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_EXPIRED: 'ROOM_EXPIRED',
  ROOM_CLOSED: 'ROOM_CLOSED',
  INVALID_PASSWORD: 'INVALID_PASSWORD',
  ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_HOST: 'NOT_HOST',
  NOT_DRAWER: 'NOT_DRAWER',
  ALREADY_CORRECT: 'ALREADY_CORRECT',
  TURN_NOT_ACTIVE: 'TURN_NOT_ACTIVE',
  INVALID_WORD: 'INVALID_WORD',
  GAME_ALREADY_STARTED: 'GAME_ALREADY_STARTED',
  NOT_ENOUGH_PLAYERS: 'NOT_ENOUGH_PLAYERS',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  CHALLENGE_NOT_FOUND: 'CHALLENGE_NOT_FOUND',
  CHALLENGE_EXPIRED: 'CHALLENGE_EXPIRED',
  MAX_ATTEMPTS_REACHED: 'MAX_ATTEMPTS_REACHED',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const;
