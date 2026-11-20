import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { WordService } from '../word/word.service';
import {
  GAME_CONSTANTS,
  normalizeGuess,
  validateGuess,
} from '@drawbattle/shared';
import type { WordDifficulty } from '@drawbattle/shared';
import type { ChallengeStroke } from './challenge.dto';

export interface Identity {
  userId?: string;
  sessionId?: string;
}

/** Shared identity predicate used by both the filtered queries and in-memory filters. */
function ownsAttempt(attempt: { solverId?: string | null; solverSessionId?: string | null }, identity: Identity): boolean {
  return Boolean(
    (identity.userId && attempt.solverId === identity.userId) ||
    (identity.sessionId && attempt.solverSessionId === identity.sessionId),
  );
}

@Injectable()
export class ChallengeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wordService: WordService,
  ) {}

  async create(
    options?: { difficulty?: WordDifficulty; category?: string; wordId?: string },
    creator?: Identity,
  ) {
    if (!creator?.userId && !creator?.sessionId) {
      throw new BadRequestException('Authentication required to create a challenge');
    }
    let word: { id: string; canonical: string };
    if (options?.wordId) {
      const found = await this.prisma.word.findFirst({
        where: { id: options.wordId, active: true },
        select: { id: true, canonical: true },
      });
      if (!found) throw new BadRequestException('Word not available');
      word = found;
    } else {
      const wordOptions = await this.wordService.pickRandomWords(1, {
        difficulty: options?.difficulty,
        category: options?.category,
      });
      if (wordOptions.length === 0) throw new BadRequestException('No words available');
      word = wordOptions[0];
    }

    const challenge = await this.prisma.challenge.create({
      data: {
        wordId: word.id,
        expiresAt: new Date(Date.now() + GAME_CONSTANTS.CHALLENGE_TTL_MS),
        creatorId: creator?.userId,
        creatorSessionId: creator?.sessionId,
      },
    });

    return {
      challengeId: challenge.id,
      word: word.canonical,
      timeLimit: GAME_CONSTANTS.CHALLENGE_DRAW_TIME,
    };
  }

  async finalize(
    challengeId: string,
    strokes: ChallengeStroke[],
    durationMs: number,
    actor?: Identity,
  ) {
    // The DTO validates shape in the controller; these runtime checks keep the
    // service safe for direct callers (tests, internal consumers) as well.
    if (!Array.isArray(strokes) || strokes.length > GAME_CONSTANTS.MAX_STROKES_PER_TURN) {
      throw new BadRequestException('Invalid strokes payload');
    }
    if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > GAME_CONSTANTS.CHALLENGE_DRAW_TIME * 1000) {
      throw new BadRequestException('Invalid duration');
    }
    for (const s of strokes) {
      if (
        !s ||
        typeof s.strokeId !== 'string' ||
        s.strokeId.length === 0 ||
        s.strokeId.length > 64 ||
        !Array.isArray(s.points) ||
        s.points.length > GAME_CONSTANTS.MAX_POINTS_PER_STROKE ||
        typeof s.color !== 'string' ||
        !/^#[0-9a-fA-F]{6}$/.test(s.color) ||
        !Number.isInteger(s.width) ||
        s.width < 1 ||
        s.width > 64 ||
        !s.points.every(
          p =>
            p &&
            typeof p.x === 'number' &&
            typeof p.y === 'number' &&
            Number.isFinite(p.x) &&
            Number.isFinite(p.y) &&
            p.x >= 0 &&
            p.x <= 1 &&
            p.y >= 0 &&
            p.y <= 1,
        )
      ) {
        throw new BadRequestException('Invalid stroke data');
      }
    }

    return this.prisma.$transaction(async tx => {
      const challenge = await tx.challenge.findUnique({ where: { id: challengeId } });
      if (!challenge) throw new NotFoundException('Challenge not found');
      if (challenge.expiresAt < new Date()) throw new BadRequestException('Challenge expired');
      if (challenge.status !== 'ACTIVE') throw new BadRequestException('Challenge not active');
      if (challenge.replayId) throw new BadRequestException('Challenge already finalized');

      if (!actor?.userId && !actor?.sessionId) {
        throw new ForbiddenException('Authentication required to finalize');
      }
      if (challenge.creatorSessionId) {
        if (!actor.sessionId || challenge.creatorSessionId !== actor.sessionId) {
          throw new ForbiddenException('Only the creator can finalize');
        }
      }
      if (challenge.creatorId) {
        if (!actor.userId || challenge.creatorId !== actor.userId) {
          throw new ForbiddenException('Only the creator can finalize');
        }
      }

      const replay = await tx.replay.create({
        data: { challengeId, strokes: strokes as any, durationMs },
      });
      await tx.challenge.update({
        where: { id: challengeId },
        data: { replayId: replay.id },
      });
      return { ok: true };
    });
  }

  async getInfo(challengeId: string, solver?: Identity) {
    // CH-03: only load the caller's attempts, never every solver's attempts.
    const identityFilter = solver
      ? {
          OR: [
            ...(solver.userId ? [{ solverId: solver.userId }] : []),
            ...(solver.sessionId ? [{ solverSessionId: solver.sessionId }] : []),
          ],
        }
      : null;

    const [challenge, attemptCount, myAttempts] = await Promise.all([
      this.prisma.challenge.findUnique({
        where: { id: challengeId },
        include: { replay: true, word: { select: { canonical: true } } },
      }),
      this.prisma.challengeAttempt.count({ where: { challengeId } }),
      identityFilter
        ? this.prisma.challengeAttempt.findMany({
            where: { challengeId, ...identityFilter },
            select: { correct: true, solverId: true, solverSessionId: true },
          })
        : Promise.resolve([]),
    ]);
    if (!challenge) throw new NotFoundException('Challenge not found');

    // A challenge whose identity fields do not match the caller is still counted
    // globally (attemptCount is public metadata) but yields no personal state.
    const owned = identityFilter ? myAttempts.filter(a => ownsAttempt(a, solver!)) : [];

    return {
      challengeId: challenge.id,
      status: challenge.expiresAt < new Date() ? 'EXPIRED' : challenge.status,
      expiresAt: challenge.expiresAt.toISOString(),
      hasReplay: Boolean(challenge.replayId),
      replay: challenge.replay
        ? { strokes: challenge.replay.strokes, durationMs: challenge.replay.durationMs }
        : null,
      attemptCount,
      myAttempts: owned.length,
      // CH-01: expose whether this caller has already solved the challenge so
      // a reload of the shared link restores the finished state. The canonical
      // answer is only sent after a correct guess by this caller.
      mySolved: owned.some(a => a.correct),
      answerCanonical: owned.some(a => a.correct) ? challenge.word.canonical : undefined,
      maxAttempts: GAME_CONSTANTS.MAX_CHALLENGE_ATTEMPTS,
    };
  }

  async submitGuess(
    challengeId: string,
    answer: string,
    solver?: Identity,
  ) {
    if (!solver?.userId && !solver?.sessionId) {
      throw new BadRequestException('Authentication required to guess');
    }
    if (typeof answer !== 'string' || answer.trim().length === 0 || answer.length > 200) {
      throw new BadRequestException('Invalid answer');
    }

    // CH-05: the lock only needs to cover this solver's attempt-count check.
    // Previously every solver contended on one challenge-wide lock, so one slow
    // transaction blocked every other solver of the same challenge.
    const identityKey = solver.userId ?? solver.sessionId ?? '';
    const lockKey = BigInt(
      '0x' + createHash('sha256').update(`challenge-guess:${challengeId}:${identityKey}`).digest('hex').slice(0, 15),
    );
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      const challenge = await tx.challenge.findUnique({
        where: { id: challengeId },
        select: { expiresAt: true, replayId: true, word: { select: { canonical: true, synonyms: true } } },
      });
      if (!challenge) throw new NotFoundException('Challenge not found');
      if (challenge.expiresAt < new Date()) throw new BadRequestException('Challenge expired');
      if (!challenge.replayId) throw new BadRequestException('Challenge not finalized');

      // CH-04: query only this solver's attempts instead of include: attempts: true
      // which fetched every attempt from every solver.
      const countWhere = {
        challengeId,
        OR: [
          ...(solver.userId ? [{ solverId: solver.userId }] : []),
          ...(solver.sessionId ? [{ solverSessionId: solver.sessionId }] : []),
        ],
      };
      const [priorCount, solvedAttempt] = await Promise.all([
        tx.challengeAttempt.count({ where: countWhere }),
        tx.challengeAttempt.findFirst({ where: { ...countWhere, correct: true }, select: { id: true } }),
      ]);

      if (solvedAttempt) {
        throw new BadRequestException('Already solved');
      }
      if (priorCount >= GAME_CONSTANTS.MAX_CHALLENGE_ATTEMPTS) {
        return {
          correct: false,
          attemptNo: priorCount,
          remainingAttempts: 0,
          answer: challenge.word.canonical,
        };
      }

      const synonyms = (challenge.word.synonyms as string[]) ?? [];
      const correct = validateGuess(answer, challenge.word.canonical, synonyms);
      const attemptNo = priorCount + 1;

      await tx.challengeAttempt.create({
        data: {
          challengeId,
          solverId: solver.userId,
          solverSessionId: solver.sessionId,
          attemptNo,
          answer,
          normalized: normalizeGuess(answer),
          correct,
        },
      });

      const remaining = GAME_CONSTANTS.MAX_CHALLENGE_ATTEMPTS - attemptNo;
      return {
        correct,
        attemptNo,
        remainingAttempts: remaining,
        answer: correct || remaining === 0 ? challenge.word.canonical : undefined,
      };
    });
  }
}
