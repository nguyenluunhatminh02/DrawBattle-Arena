import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WordService } from '../word/word.service';
import {
  GAME_CONSTANTS,
  normalizeGuess,
  validateGuess,
} from '@drawbattle/shared';
import type { WordDifficulty } from '@drawbattle/shared';

export interface Identity {
  userId?: string;
  sessionId?: string;
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
    strokes: Array<{
      strokeId: string;
      points: Array<{ x: number; y: number }>;
      color: string;
      width: number;
    }>,
    durationMs: number,
    actor?: Identity,
  ) {
    if (!Array.isArray(strokes) || strokes.length > 500) {
      throw new BadRequestException('Invalid strokes payload');
    }
    if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 30000) {
      throw new BadRequestException('Invalid duration');
    }
    for (const s of strokes) {
      if (!s.strokeId || !Array.isArray(s.points) || !s.color || !s.width) {
        throw new BadRequestException('Invalid stroke data');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const challenge = await tx.challenge.findUnique({ where: { id: challengeId } });
      if (!challenge) throw new NotFoundException('Challenge not found');
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
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      include: { replay: true, attempts: true },
    });
    if (!challenge) throw new NotFoundException('Challenge not found');

    const myAttempts = solver
      ? challenge.attempts.filter(
          a =>
            (solver.userId && a.solverId === solver.userId) ||
            (solver.sessionId && a.solverSessionId === solver.sessionId),
        )
      : [];

    return {
      challengeId: challenge.id,
      status: challenge.expiresAt < new Date() ? 'EXPIRED' : challenge.status,
      expiresAt: challenge.expiresAt.toISOString(),
      hasReplay: Boolean(challenge.replayId),
      replay: challenge.replay
        ? { strokes: challenge.replay.strokes, durationMs: challenge.replay.durationMs }
        : null,
      attemptCount: challenge.attempts.length,
      myAttempts: myAttempts.length,
      mySolved: myAttempts.some(a => a.correct),
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

    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      include: { word: true, attempts: true },
    });
    if (!challenge) throw new NotFoundException('Challenge not found');
    if (challenge.expiresAt < new Date()) throw new BadRequestException('Challenge expired');
    if (!challenge.replayId) throw new BadRequestException('Challenge not finalized');

    const priorAttempts = challenge.attempts.filter(
      a =>
        (solver.userId && a.solverId === solver.userId) ||
        (solver.sessionId && a.solverSessionId === solver.sessionId),
    );

    if (priorAttempts.some(a => a.correct)) {
      throw new BadRequestException('Already solved');
    }
    if (priorAttempts.length >= GAME_CONSTANTS.MAX_CHALLENGE_ATTEMPTS) {
      return {
        correct: false,
        attemptNo: priorAttempts.length,
        remainingAttempts: 0,
        answer: challenge.word.canonical,
      };
    }

    const synonyms = (challenge.word.synonyms as string[]) ?? [];
    const correct = validateGuess(answer, challenge.word.canonical, synonyms);
    const attemptNo = priorAttempts.length + 1;

    await this.prisma.challengeAttempt.create({
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
  }
}
