import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ChallengeService } from '../../src/modules/challenge/challenge.service';
import { RoomService } from '../../src/modules/room/room.service';
import { MatchService } from '../../src/modules/match/match.service';

/**
 * DB-backed regression matrix (TEST-01..TEST-14 where persistence matters).
 * Requires DATABASE_URL pointing to a migrated PostgreSQL instance:
 *   pnpm --filter @drawbattle/api test:integration
 */
describe('Regression integration tests', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let challenges: ChallengeService;
  let rooms: RoomService;
  let matches: MatchService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    challenges = moduleRef.get(ChallengeService);
    rooms = moduleRef.get(RoomService);
    matches = moduleRef.get(MatchService);
  });

  afterAll(async () => {
    await app.close();
  });

  const makeChallenge = async (creatorSessionId = 'owner') => {
    const word = await prisma.word.findFirst({ where: { active: true } });
    if (!word) throw new Error('Seed the database before integration tests');
    return prisma.challenge.create({
      data: {
        wordId: word.id,
        creatorSessionId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  };

  const deleteChallenge = async (id: string) => {
    const challenge = await prisma.challenge.findUnique({ where: { id } });
    // Challenge.replayId and Replay.challengeId reference each other; clear
    // the challenge side first so the replay row can be removed safely.
    if (challenge?.replayId) {
      await prisma.challenge.update({ where: { id }, data: { replayId: null } });
      await prisma.replay.delete({ where: { id: challenge.replayId } });
    }
    await prisma.challenge.delete({ where: { id } });
  };

  const makeGuest = async (suffix: string) =>
    prisma.guestSession.create({
      data: {
        tokenHash: `integration-${suffix}-${Date.now()}-${Math.random()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

  const strokes = [{ strokeId: 's1', points: [{ x: 0.1, y: 0.1 }], color: '#000', width: 2 }];

  it('TEST-01/02/03 enforces finalize ownership against a real database', async () => {
    const challenge = await makeChallenge();
    try {
      await expect(challenges.finalize(challenge.id, strokes as any, 5000)).rejects.toThrow(
        /Authentication required/,
      );
      await expect(
        challenges.finalize(challenge.id, strokes as any, 5000, { sessionId: 'stranger' }),
      ).rejects.toThrow(/Only the creator/);
      await expect(
        challenges.finalize(challenge.id, strokes as any, 5000, { sessionId: 'owner' }),
      ).resolves.toEqual({ ok: true });
    } finally {
      await deleteChallenge(challenge.id);
    }
  });

  it('TEST-04/05 keeps finalize single-use and payload validation strict', async () => {
    const challenge = await makeChallenge();
    try {
      await expect(
        challenges.finalize(challenge.id, strokes as any, 999, { sessionId: 'owner' }),
      ).rejects.toThrow(/Invalid duration/);
      await expect(
        challenges.finalize(challenge.id, strokes as any, 5000, { sessionId: 'owner' }),
      ).resolves.toEqual({ ok: true });
      await expect(
        challenges.finalize(challenge.id, strokes as any, 5000, { sessionId: 'owner' }),
      ).rejects.toThrow(/already finalized/);
    } finally {
      await deleteChallenge(challenge.id);
    }
  });

  it('TEST-07/08 reveals the answer only on a correct final guess', async () => {
    const challenge = await makeChallenge('solver');
    try {
      await expect(challenges.submitGuess(challenge.id, 'con mèo')).rejects.toThrow(
        /Authentication required/,
      );
      await challenges.finalize(challenge.id, strokes as any, 5000, { sessionId: 'owner' });
      const wrong = await challenges.submitGuess(challenge.id, 'not the word', {
        sessionId: 'solver',
      });
      expect(wrong.correct).toBe(false);
      expect(wrong.answer).toBeUndefined();
      const word = await prisma.word.findUnique({ where: { id: challenge.wordId } });
      const right = await challenges.submitGuess(challenge.id, word!.canonical, {
        sessionId: 'solver',
      });
      expect(right.correct).toBe(true);
      expect(right.answer).toBe(word!.canonical);
    } finally {
      await deleteChallenge(challenge.id);
    }
  });

  it('TEST-13 persists exactly one player row for a reconnect', async () => {
    const hostGuest = await makeGuest('host-reconnect');
    const guestGuest = await makeGuest('guest-reconnect');
    const created = await rooms.createRoom('Host', hostGuest.id, null);
    try {
      await rooms.joinRoom(created.roomCode, 'Guest', guestGuest.id, null);
      const rejoin = await rooms.joinRoom(created.roomCode, 'Guest', guestGuest.id, null);
      expect(rejoin.playerId).toBeTruthy();
      const rows = await prisma.roomPlayer.count({
        where: { roomId: created.roomId, guestSessionId: guestGuest.id },
      });
      expect(rows).toBe(1);
    } finally {
      await prisma.room.delete({ where: { id: created.roomId } });
      await prisma.guestSession.deleteMany({
        where: { id: { in: [hostGuest.id, guestGuest.id] } },
      });
    }
  });

  it('TEST-14 room info never exposes the password hash', async () => {
    const hostGuest = await makeGuest('host-password');
    const created = await rooms.createRoom('Host', hostGuest.id, null, {
      password: 'secret123',
      maxPlayers: 4,
    });
    try {
      const info = await rooms.getRoomInfo(created.roomCode);
      expect(info.hasPassword).toBe(true);
      expect(info.settings).not.toHaveProperty('password');
      expect(info.settings).not.toHaveProperty('passwordHash');
    } finally {
      await prisma.room.delete({ where: { id: created.roomId } });
      await prisma.guestSession.delete({ where: { id: hostGuest.id } });
    }
  });

  it('private matches stay out of public history and detail responses', async () => {
    const word = await prisma.word.findFirst({ where: { active: true } });
    const room = await prisma.room.create({
      data: {
        code: `PV${Date.now().toString().slice(-6)}`,
        visibility: 'PRIVATE',
        settings: {},
        expiresAt: new Date(Date.now() + 60_000),
        status: 'FINISHED',
      },
    });
    const match = await prisma.match.create({
      data: {
        roomId: room.id,
        status: 'FINISHED',
        rules: {},
        startedAt: new Date(Date.now() - 10_000),
        endedAt: new Date(),
      },
    });
    try {
      const listed = await matches.listMatches(20, 0);
      expect(listed.matches.some(m => m.id === match.id)).toBe(false);
      await expect(matches.getMatch(match.id)).rejects.toThrow(/not found/i);
      await expect(matches.getMatchResults(match.id)).rejects.toThrow(/not found/i);
      expect(word).toBeTruthy();
    } finally {
      await prisma.match.delete({ where: { id: match.id } });
      await prisma.room.delete({ where: { id: room.id } });
    }
  });
});
