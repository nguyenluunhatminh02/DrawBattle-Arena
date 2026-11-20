import { BadRequestException } from '@nestjs/common';
import { DailyService, getVietnamToday } from './daily.service';

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
  const challenge = {
    id: 'd1',
    date: today,
    word: { canonical: 'mèo', synonyms: ['cat'] },
  };
  return {
    dailyChallenge: {
      findUnique: jest.fn().mockResolvedValue(challenge),
      create: jest.fn().mockResolvedValue(challenge),
    },
    dailyChallengeAttempt: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'a1', ...data })),
    },
    word: {
      findFirst: jest.fn().mockResolvedValue({ id: 'w1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    streak: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb(tx)),
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
      $executeRaw: prisma.$executeRaw,
    };
    prisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));
    service = new DailyService(prisma as any);
  });

  it('returns answerCanonical only after a correct attempt', async () => {
    prisma.dailyChallengeAttempt.findFirst.mockResolvedValue({ correct: true, answer: 'mèo' });
    const info = await service.getTodaysChallenge('u1');
    expect(info.answerCanonical).toBe('mèo');
    prisma.dailyChallengeAttempt.findFirst.mockResolvedValue({ correct: false, answer: 'sai' });
    const locked = await service.getTodaysChallenge('u1');
    expect(locked.answerCanonical).toBeUndefined();
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
