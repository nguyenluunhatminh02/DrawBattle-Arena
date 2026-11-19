import {
  BadRequestException,
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

@Injectable()
export class ChallengeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wordService: WordService,
  ) {}

  async create(options?: { difficulty?: WordDifficulty; category?: string; wordId?: string }) {
    let word: { id: string; canonical: string };
    if (options?.wordId) {
      const found = await this.prisma.word.findFirst({
        where: { id: options.wordId, active: true },
        select: { id: true, canonical: true },
      });
      if (!found) {
        throw new BadRequestException('Word not available');
      }
      word = found;
    } else {
      const wordOptions = await this.wordService.pickRandomWords(1, {
        difficulty: options?.difficulty,
        category: options?.category,
      });
      if (wordOptions.length === 0) {
        throw new BadRequestException('No words available');
      }
      word = wordOptions[0];
    }

    const challenge = await this.prisma.challenge.create({
      data: {
        wordId: word.id,
        expiresAt: new Date(Date.now() + GAME_CONSTANTS.CHALLENGE_TTL_MS),
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
  ) {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
    });
    if (!challenge) throw new NotFoundException('Challenge not found');
    if (challenge.status !== 'ACTIVE') {
      throw new BadRequestException('Challenge not active');
    }

    const replay = await this.prisma.replay.create({
      data: {
        challengeId,
        strokes,
        durationMs,
      },
    });

    await this.prisma.challenge.update({
      where: { id: challengeId },
      data: { replayId: replay.id },
    });

    return { ok: true };
  }

  async getInfo(challengeId: string) {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      include: {
        replay: true,
        attempts: true,
      },
    });
    if (!challenge) throw new NotFoundException('Challenge not found');

    return {
      challengeId: challenge.id,
      status:
        challenge.expiresAt < new Date() ? 'EXPIRED' : challenge.status,
      expiresAt: challenge.expiresAt.toISOString(),
      hasReplay: Boolean(challenge.replayId),
      replay: challenge.replay
        ? {
            strokes: challenge.replay.strokes,
            durationMs: challenge.replay.durationMs,
          }
        : null,
      attemptCount: challenge.attempts.length,
      maxAttempts: GAME_CONSTANTS.MAX_CHALLENGE_ATTEMPTS,
    };
  }

  async submitGuess(challengeId: string, answer: string, solverId?: string) {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      include: { word: true, attempts: true },
    });
    if (!challenge) throw new NotFoundException('Challenge not found');
    if (challenge.expiresAt < new Date()) {
      throw new BadRequestException('Challenge expired');
    }
    if (!challenge.replayId) {
      throw new BadRequestException('Challenge not finalized');
    }

    const priorAttempts = challenge.attempts.filter(
      a => a.solverId === solverId || (!solverId && !a.solverId),
    );
    if (priorAttempts.some(a => a.correct)) {
      throw new BadRequestException('Already solved');
    }
    if (priorAttempts.length >= GAME_CONSTANTS.MAX_CHALLENGE_ATTEMPTS) {
      const word = challenge.word;
      return {
        correct: false,
        attemptNo: priorAttempts.length,
        remainingAttempts: 0,
        answer: word.canonical,
      };
    }

    const synonyms = (challenge.word.synonyms as string[]) ?? [];
    const correct = validateGuess(answer, challenge.word.canonical, synonyms);
    const attemptNo = priorAttempts.length + 1;

    await this.prisma.challengeAttempt.create({
      data: {
        challengeId,
        solverId,
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
