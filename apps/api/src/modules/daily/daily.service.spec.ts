import { BadRequestException } from '@nestjs/common';
import { DailyService, getVietnamToday, hasValidReplayStrokes } from './daily.service';

// Jest in this repo does not transform @nestjs/schedule's ESM build; the
// decorator is irrelevant to these pure service tests.
jest.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined }));

describe('getVietnamToday (DAILY-06)', () => {
  it('uses the UTC+7 calendar date, not the host timezone', () => {
    // 2026-06-15 17:30Z is already 2026-06-16 in Ho Chi Minh City.
    expect(getVietnamToday(new Date('2026-06-15T17:30:00.000Z')).toISOString()).toBe('2026-06-16T00:00:00.000Z');
  });

  it('keeps the same day for UTC midday', () => {
    expect(getVietnamToday(new Date('2026-06-15T05:00:00.000Z')).toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });

  it('handles a month boundary', () => {
    expect(getVietnamToday(new Date('2026-06-30T18:00:00.000Z')).toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });
});

function createPrismaMock() {
  const today = getVietnamToday();
  const replayStrokes = [
    {
      strokeId: 's1',
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.8 },
      ],
      color: '#000000',
      width: 4,
    },
  ];
  const challenge = {
    id: 'd1',
    date: today,
    replay: {
      id: 'r1',
      strokes: replayStrokes,
      durationMs: 3000,
      turn: { round: { match: { room: { visibility: 'PUBLIC' } } } },
    },
    word: {
      id: 'w1',
      canonical: 'mèo',
      synonyms: ['cat'],
      difficulty: 'EASY',
      category: { name: 'Động vật' },
    },
  };
  return {
    dailyChallenge: {
      findUnique: jest.fn().mockResolvedValue(challenge),
      create: jest.fn().mockResolvedValue(challenge),
    },
    replay: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({
        id: 'r1',
        turn: null,
        challenge: { wordId: 'w1' },
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    dailyChallengeAttempt: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'a1', ...data })),
    },
    word: {
      findUnique: jest.fn().mockResolvedValue({ canonical: 'mèo' }),
      findFirst: jest.fn().mockResolvedValue({ id: 'w1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    streak: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation(async (cb: (t: unknown) => unknown) => cb({})),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
}

describe('DailyService hardening', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: DailyService;
  let tx: Record<string, unknown>;

  beforeEach(() => {
    prisma = createPrismaMock();
    tx = {
      dailyChallenge: prisma.dailyChallenge,
      dailyChallengeAttempt: prisma.dailyChallengeAttempt,
      streak: prisma.streak,
      replay: prisma.replay,
      word: prisma.word,
      $executeRaw: prisma.$executeRaw,
    };
    prisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));
    service = new DailyService(prisma as any);
  });

  it('returns a replay-backed drawing for today', async () => {
    prisma.dailyChallenge.findUnique.mockResolvedValue({
      id: 'd1',
      date: getVietnamToday(),
      replay: {
        id: 'r1',
        strokes: [
          { strokeId: 's1', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: '#000000', width: 4 },
        ],
        durationMs: 3000,
        turn: { round: { match: { room: { visibility: 'PUBLIC' } } } },
      },
      word: { id: 'w1', difficulty: 'EASY', category: { name: 'Động vật' } },
    });

    const info = await service.getTodaysChallenge('u1');

    expect(info.hasReplay).toBe(true);
    expect(info.replay.strokes).toHaveLength(1);
    expect(info.replay.strokes[0].strokeId).toBe('s1');
    expect(info.replay.durationMs).toBe(3000);
    expect(JSON.stringify(info)).not.toContain('dailyId');
  });

  it('never serves a replay from a PRIVATE room even if linked to daily', async () => {
    prisma.dailyChallenge.findUnique.mockResolvedValue({
      id: 'd1',
      date: getVietnamToday(),
      replay: {
        id: 'private-r',
        strokes: [{ strokeId: 's1', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
        durationMs: 3000,
        turn: { round: { match: { room: { visibility: 'PRIVATE' } } } },
      },
      word: { id: 'w1', difficulty: 'EASY', category: null },
    });

    const info = await service.getTodaysChallenge('u1');
    expect(info.hasReplay).toBe(false);
    expect(info.replay).toBeNull();
  });

  it('never includes blank or single-point strokes', async () => {
    expect(hasValidReplayStrokes([])).toBe(false);
    expect(hasValidReplayStrokes([{ points: [{ x: 0, y: 0 }] }])).toBe(false);
    expect(hasValidReplayStrokes([{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }])).toBe(true);
  });

  it('selects a word that already has a replay when generating the daily', async () => {
    prisma.dailyChallenge.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'd1',
        date: getVietnamToday(),
        replay: null,
        word: { id: 'w1', difficulty: 'EASY', category: null },
      });
    prisma.replay.findMany.mockResolvedValue([{
      id: 'r1',
      strokes: [{ strokeId: 's1', points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }] }],
      turn: {
        wordId: 'w1',
        round: { match: { room: { visibility: 'PUBLIC' } } },
      },
    }]);
    prisma.word.findFirst.mockResolvedValue({ id: 'w1' });

    await service.getTodaysChallenge();

    expect(prisma.replay.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        dailyId: null,
        turnId: { not: null },
        turn: { is: { word: { is: { active: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }));
    expect(prisma.dailyChallenge.create).toHaveBeenCalledWith({
      data: { date: getVietnamToday(), wordId: 'w1' },
    });
    expect(prisma.replay.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', dailyId: null },
      data: { dailyId: 'd1' },
    });
  });

  it('falls back to an active word when no replay-backed word exists', async () => {
    prisma.dailyChallenge.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'd1',
        date: getVietnamToday(),
        replay: null,
        word: { id: 'w1', difficulty: 'EASY', category: null },
      });
    prisma.replay.findMany.mockResolvedValue([]);

    await service.getTodaysChallenge();

    expect(prisma.word.findFirst).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: { usageCount: 'asc' },
      select: { id: true },
    });
    expect(prisma.replay.updateMany).not.toHaveBeenCalled();
  });

  it('returns answerCanonical only after a correct attempt', async () => {
    prisma.dailyChallengeAttempt.findFirst.mockResolvedValue({
      id: 'a1', correct: true, createdAt: new Date(), answer: 'mèo',
    });
    const info = await service.getTodaysChallenge('u1');
    expect(info.answerCanonical).toBe('mèo');
    prisma.dailyChallengeAttempt.findFirst.mockResolvedValue({
      id: 'a2', correct: false, createdAt: new Date(), answer: 'sai',
    });
    const locked = await service.getTodaysChallenge('u1');
    expect(locked.answerCanonical).toBeUndefined();
  });

  it('does not leak the canonical answer or synonyms to an unsolved caller', async () => {
    // A raw guess is itself sensitive: use the secret as the stored answer to
    // prove that userAttempt is sanitised too.
    prisma.dailyChallengeAttempt.findFirst.mockResolvedValue({
      id: 'a2', correct: false, createdAt: new Date(), answer: 'mèo', normalized: 'meo',
    });

    const response = await service.getTodaysChallenge('u1');

    expect(response.answerCanonical).toBeUndefined();
    expect(response.word.canonical).toBeUndefined();
    expect(response.word.synonyms).toBeUndefined();
    expect(response.userAttempt.answer).toBeUndefined();
    expect(response.userAttempt.normalized).toBeUndefined();
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('mèo');
    expect(serialized).not.toContain('meo');
    expect(serialized).not.toContain('"synonyms"');
  });

  it('shows answerCanonical to a caller who has solved the daily', async () => {
    prisma.dailyChallengeAttempt.findFirst.mockResolvedValue({
      id: 'a1', correct: true, createdAt: new Date(), answer: 'mèo',
    });

    const response = await service.getTodaysChallenge('u1');

    expect(response.answerCanonical).toBe('mèo');
    expect(response.word.canonical).toBeUndefined();
    expect(response.userAttempt.answer).toBeUndefined();
  });

  it('uses the account identity and ignores a guest token when both are present', async () => {
    await service.getTodaysChallenge('u1', 'guest-1');
    const where = prisma.dailyChallengeAttempt.findFirst.mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(where.guestSessionId).toBeUndefined();
  });

  it('rejects attempts after the per-identity cap', async () => {
    prisma.dailyChallengeAttempt.findMany.mockResolvedValue(
      Array.from({ length: 10 }, () => ({ correct: false, createdAt: new Date(Date.now() - 5000) })),
    );
    await expect(service.submitAttempt('d1', 'mèo', 'u1')).rejects.toThrow(BadRequestException);
    expect(prisma.dailyChallengeAttempt.create).not.toHaveBeenCalled();
  });

  it('throttles rapid successive guesses', async () => {
    prisma.dailyChallengeAttempt.findMany.mockResolvedValue([
      { correct: false, createdAt: new Date() },
    ]);
    await expect(service.submitAttempt('d1', 'mèo', undefined, 'guest-1')).rejects.toThrow(BadRequestException);
  });

  it('returns the canonical answer on a correct guess', async () => {
    const res = await service.submitAttempt('d1', 'mèo', 'u1');
    expect(res.correct).toBe(true);
    expect(res.answerCanonical).toBe('mèo');
  });

  it('rejects stale daily challenges', async () => {
    prisma.dailyChallenge.findUnique.mockResolvedValue({
      ...(await prisma.dailyChallenge.findUnique()),
      date: new Date('2000-01-01T00:00:00.000Z'),
    });
    await expect(service.submitAttempt('d1', 'mèo', 'u1')).rejects.toThrow(BadRequestException);
  });
});
