import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Cron } from '@nestjs/schedule';
import { normalizeGuess, validateGuess } from '@drawbattle/shared';

const VIETNAM_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const MAX_DAILY_ATTEMPTS = 10;
const DAILY_ATTEMPT_COOLDOWN_MS = 1000;

/**
 * DAILY-06: the daily boundary must be midnight in Asia/Ho_Chi_Minh (UTC+7),
 * not midnight in the API host's timezone. Return the UTC instant of today's
 * local midnight as a Date with no time component (Prisma @db.Date column).
 */
export function getVietnamToday(date: Date = new Date()): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: VIETNAM_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const year = Number(part('year'));
  const month = Number(part('month'));
  const day = Number(part('day'));
  return new Date(Date.UTC(year, month - 1, day));
}

function previousVietnamDay(today: Date): Date {
  const previous = new Date(today);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous;
}

@Injectable()
export class DailyService {
  constructor(private prisma: PrismaService) {}

  // UTC 17:00 is midnight in Asia/Ho_Chi_Minh (UTC+7, no DST). On-demand
  // generation in getTodaysChallenge covers downtime around that boundary.
  @Cron('0 17 * * *')
  async generateDailyChallenge() {
    const today = getVietnamToday();

    const lockKey = BigInt('0x' + createHash('sha256').update(`daily:${today.toISOString()}`).digest('hex').slice(0, 15));
    await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      const existing = await tx.dailyChallenge.findUnique({
        where: { date: today },
      });
      if (existing) return;

      const randomWord = await tx.word.findFirst({
        where: { active: true },
        orderBy: { usageCount: 'asc' },
      });
      if (!randomWord) throw new Error('No active words available');

      await tx.dailyChallenge.create({
        data: { date: today, wordId: randomWord.id },
      });
      await tx.word.update({
        where: { id: randomWord.id },
        data: { usageCount: { increment: 1 } },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async getTodaysChallenge(userId?: string, guestSessionId?: string): Promise<any> {
    const today = getVietnamToday();

    let challenge = await this.findChallenge(today);
    if (!challenge) {
      await this.generateDailyChallenge();
      challenge = await this.findChallenge(today);
    }
    if (!challenge) {
      throw new BadRequestException('Daily challenge unavailable');
    }

    // DAILY-05: an authenticated user's history must never be attributed to a
    // guest token (and vice versa). The controller already normalises the
    // identity; keep the predicate here explicit as a defence in depth.
    const identityWhere = userId
      ? { userId }
      : guestSessionId
        ? { guestSessionId }
        : null;

    const [userAttempt, totalAttempts, correctAttempts] = await Promise.all([
      identityWhere
        ? this.prisma.dailyChallengeAttempt.findFirst({
            where: { dailyChallengeId: challenge.id, ...identityWhere },
            orderBy: { createdAt: 'desc' },
            // Never return the raw guess: it can itself be (or contain) the answer.
            select: { id: true, correct: true, createdAt: true },
          })
        : Promise.resolve(null),
      this.prisma.dailyChallengeAttempt.count({ where: { dailyChallengeId: challenge.id } }),
      this.prisma.dailyChallengeAttempt.count({
        where: { dailyChallengeId: challenge.id, correct: true },
      }),
    ]);

    // DAILY-02: build an explicit DTO. Spreading the Prisma row would leak any
    // newly added field (including the canonical word or its synonyms) before
    // the caller has solved today's challenge.
    const solved = userAttempt?.correct === true;
    let answerCanonical: string | undefined;
    if (solved) {
      const word = await this.prisma.word.findUnique({
        where: { id: challenge.word.id },
        select: { canonical: true },
      });
      answerCanonical = word?.canonical;
    }

    return {
      id: challenge.id,
      date: challenge.date,
      word: {
        id: challenge.word.id,
        difficulty: challenge.word.difficulty,
        category: challenge.word.category
          ? { name: challenge.word.category.name }
          : null,
      },
      replay: challenge.replay,
      answerCanonical,
      // Explicit sanitisation even if a caller/mock supplies a richer attempt.
      userAttempt: userAttempt
        ? { id: userAttempt.id, correct: userAttempt.correct, createdAt: userAttempt.createdAt }
        : null,
      stats: {
        totalAttempts,
        correctAttempts,
        successRate: totalAttempts > 0 ? (correctAttempts / totalAttempts) * 100 : 0,
      },
    };
  }

  private findChallenge(today: Date) {
    return this.prisma.dailyChallenge.findUnique({
      where: { date: today },
      select: {
        id: true,
        date: true,
        replay: true,
        word: {
          select: {
            id: true,
            difficulty: true,
            category: { select: { name: true } },
          },
        },
      },
    });
  }

  async submitAttempt(
    dailyChallengeId: string,
    answer: string,
    userId?: string,
    guestSessionId?: string,
  ) {
    if (!userId && !guestSessionId) {
      throw new BadRequestException('User or guest session required');
    }
    if (typeof answer !== 'string' || answer.trim().length === 0 || answer.length > 200) {
      throw new BadRequestException('Invalid answer');
    }

    const challenge = await this.prisma.dailyChallenge.findUnique({
      where: { id: dailyChallengeId },
      include: { word: { select: { canonical: true, synonyms: true } } },
    });
    if (!challenge) {
      throw new NotFoundException('Challenge not found');
    }
    if (challenge.date.getTime() !== getVietnamToday().getTime()) {
      throw new BadRequestException('Daily challenge expired');
    }

    // Serialize the check-then-create under an advisory lock so concurrent
    // submissions cannot both pass the "already solved" gate.
    const identityKey = userId ?? guestSessionId ?? '';
    const lockKey = BigInt('0x' + createHash('sha256').update(`daily-submit:${dailyChallengeId}:${identityKey}`).digest('hex').slice(0, 15));

    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      const current = await tx.dailyChallenge.findUnique({
        where: { id: dailyChallengeId },
        include: { word: { select: { canonical: true, synonyms: true } } },
      });
      if (!current) throw new NotFoundException('Challenge not found');

      const identityWhere = userId ? { userId } : { guestSessionId: guestSessionId! };
      const attempts = await tx.dailyChallengeAttempt.findMany({
        where: { dailyChallengeId, ...identityWhere },
        orderBy: { createdAt: 'desc' },
        select: { correct: true, createdAt: true },
      });

      if (attempts.some(a => a.correct)) throw new BadRequestException('Already solved today');

      // DAILY-04: enforce a per-identity cap and a short cooldown between
      // guesses so an endless submit loop cannot flood the attempts table.
      if (attempts.length >= MAX_DAILY_ATTEMPTS) {
        throw new BadRequestException('Đã hết lượt đoán hôm nay. Vui lòng quay lại ngày mai.');
      }
      if (attempts.length > 0 && Date.now() - attempts[0].createdAt.getTime() < DAILY_ATTEMPT_COOLDOWN_MS) {
        throw new BadRequestException('Vui lòng đợi một giây trước khi đoán lại.');
      }

      const normalized = normalizeGuess(answer);
      const synonyms = (current.word.synonyms as string[]) ?? [];
      const correct = validateGuess(answer, current.word.canonical, synonyms);

      const attempt = await tx.dailyChallengeAttempt.create({
        data: {
          dailyChallengeId,
          userId,
          guestSessionId,
          answer,
          normalized,
          correct,
        },
      });

      if (correct && userId) {
        await this.updateStreak(userId, tx);
      }

      return {
        attempt,
        correct,
        remainingAttempts: MAX_DAILY_ATTEMPTS - attempts.length - 1,
        answerCanonical: correct ? current.word.canonical : undefined,
      };
    });
  }

  private async updateStreak(userId: string, tx?: any) {
    const client = tx ?? this.prisma;
    const today = getVietnamToday();
    const yesterday = previousVietnamDay(today);

    // Use upsert so concurrent calls cannot race between findUnique and create.
    const existing = await client.streak.findUnique({ where: { userId } });

    if (!existing) {
      return client.streak.create({
        data: {
          userId,
          currentStreak: 1,
          longestStreak: 1,
          lastPlayedAt: today,
        },
      });
    }

    const lastPlayed = getVietnamToday(new Date(existing.lastPlayedAt));

    let newStreak = existing.currentStreak;
    if (lastPlayed.getTime() === today.getTime()) {
      return existing;
    } else if (lastPlayed.getTime() === yesterday.getTime()) {
      newStreak = existing.currentStreak + 1;
    } else {
      newStreak = 1;
    }

    const longestStreak = Math.max(existing.longestStreak, newStreak);

    return client.streak.update({
      where: { userId },
      data: {
        currentStreak: newStreak,
        longestStreak,
        lastPlayedAt: today,
      },
    });
  }

  async getStreak(userId: string) {
    const streak = await this.prisma.streak.findUnique({ where: { userId } });
    return streak || { currentStreak: 0, longestStreak: 0, lastPlayedAt: null };
  }
}
