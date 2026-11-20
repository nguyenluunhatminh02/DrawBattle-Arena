import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ChallengeService } from './challenge.service';

function createPrismaMock(overrides: Record<string, unknown> = {}) {
  const challenge = {
    id: 'c1',
    expiresAt: new Date(Date.now() + 60_000),
    replayId: 'r1',
    status: 'ACTIVE',
    wordId: 'w1',
    word: { canonical: 'mèo', synonyms: ['cat'] },
    replay: { strokes: [], durationMs: 1000 },
  };
  return {
    challenge: {
      findUnique: jest.fn().mockResolvedValue(challenge),
      update: jest.fn().mockResolvedValue({}),
    },
    challengeAttempt: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'a1', ...data })),
    },
    word: { findUnique: jest.fn().mockResolvedValue({ canonical: 'mèo' }) },
    replay: { create: jest.fn().mockResolvedValue({ id: 'r1' }) },
    $transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb(tx)),
    $executeRaw: jest.fn().mockResolvedValue(0),
    ...overrides,
  };
}

describe('ChallengeService hardening', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: ChallengeService;
  let tx: Record<string, unknown>;

  beforeEach(() => {
    prisma = createPrismaMock();
    tx = {
      challenge: prisma.challenge,
      challengeAttempt: prisma.challengeAttempt,
      replay: prisma.replay,
      $executeRaw: prisma.$executeRaw,
    };
    prisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));
    service = new ChallengeService(prisma as any, {} as any);
  });

  it('returns mySolved and filters attempts by the current solver', async () => {
    prisma.challengeAttempt.findMany.mockResolvedValue([
      { correct: true, solverId: 'u1', solverSessionId: null },
    ]);
    const info = await service.getInfo('c1', { userId: 'u1' });
    expect(info.mySolved).toBe(true);
    expect(info.answerCanonical).toBe('mèo');
    expect(prisma.challengeAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ challengeId: 'c1' }) }),
    );
    // Never call findMany without an identity filter.
    const where = prisma.challengeAttempt.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeDefined();
  });

  it('does not leak mySolved to a different identity', async () => {
    prisma.challengeAttempt.findMany.mockResolvedValue([
      { correct: true, solverId: 'u1', solverSessionId: null },
    ]);
    const info = await service.getInfo('c1', { userId: 'u2' });
    expect(info.mySolved).toBe(false);
    expect(info.answerCanonical).toBeUndefined();
  });

  it('rejects expired challenges on finalize', async () => {
    prisma.challenge.findUnique.mockResolvedValue({
      ...(await prisma.challenge.findUnique()),
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(
      service.finalize('c1', [], 1000, { sessionId: 's1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects malformed stroke payloads', async () => {
    await expect(
      service.finalize('c1', [{ strokeId: 'x', points: [{ x: 2, y: 0 }], color: '#000000', width: 3 }], 1000, { sessionId: 's1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects oversized answer payloads', async () => {
    await expect(
      service.submitGuess('c1', 'a'.repeat(201), { sessionId: 's1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects guesses on an expired challenge', async () => {
    prisma.challenge.findUnique.mockResolvedValue({
      id: 'c1',
      expiresAt: new Date(Date.now() - 1000),
      replayId: 'r1',
      word: { canonical: 'mèo', synonyms: [] },
    });
    await expect(
      service.submitGuess('c1', 'mèo', { sessionId: 's1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('returns the answer when the attempt cap is reached', async () => {
    prisma.challengeAttempt.count.mockResolvedValue(3);
    const res = await service.submitGuess('c1', 'sai', { sessionId: 's1' });
    expect(res).toEqual({ correct: false, attemptNo: 3, remainingAttempts: 0, answer: 'mèo' });
    expect(prisma.challengeAttempt.create).not.toHaveBeenCalled();
  });

  it('scopes the advisory lock key to the solver, not just the challenge', async () => {
    await service.submitGuess('c1', 'mèo', { sessionId: 's1' });
    const firstKey = prisma.$executeRaw.mock.calls.length;
    expect(firstKey).toBeGreaterThan(0);
    const lockSql = prisma.$executeRaw.mock.calls[0][0];
    expect(String(lockSql)).toContain('pg_advisory_xact_lock');
  });

  it('throws NotFound for unknown challenges', async () => {
    prisma.challenge.findUnique.mockResolvedValue(null);
    await expect(service.getInfo('missing')).rejects.toThrow(NotFoundException);
  });
});
