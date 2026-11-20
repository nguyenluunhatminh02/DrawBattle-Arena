import { Injectable, BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { normalizeGuess, validateGuess } from '@drawbattle/shared';

@Injectable()
export class DailyService {
  constructor(private prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async generateDailyChallenge() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

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
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let challenge = await this.prisma.dailyChallenge.findUnique({
      where: { date: today },
      include: {
        word: {
          select: {
            id: true,
            difficulty: true,
            category: { select: { name: true } },
          },
        },
        replay: true,
      },
    });

    if (!challenge) {
      await this.generateDailyChallenge();
      challenge = await this.prisma.dailyChallenge.findUnique({
        where: { date: today },
        include: {
          word: {
            select: {
              id: true,
              difficulty: true,
              category: { select: { name: true } },
            },
          },
          replay: true,
        },
      });
    }

    if (!challenge) {
      throw new BadRequestException('Daily challenge unavailable');
    }

    let userAttempt = null;
    if (userId) {
      userAttempt = await this.prisma.dailyChallengeAttempt.findFirst({
        where: { dailyChallengeId: challenge.id, userId },
        orderBy: { createdAt: 'desc' },
      });
    } else if (guestSessionId) {
      userAttempt = await this.prisma.dailyChallengeAttempt.findFirst({
        where: { dailyChallengeId: challenge.id, guestSessionId },
        orderBy: { createdAt: 'desc' },
      });
    }

    const totalAttempts = await this.prisma.dailyChallengeAttempt.count({
      where: { dailyChallengeId: challenge.id },
    });

    const correctAttempts = await this.prisma.dailyChallengeAttempt.count({
      where: { dailyChallengeId: challenge.id, correct: true },
    });

    return {
      ...challenge,
      userAttempt,
      stats: {
        totalAttempts,
        correctAttempts,
        successRate: totalAttempts > 0 ? (correctAttempts / totalAttempts) * 100 : 0,
      },
    };
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

    const challenge = await this.prisma.dailyChallenge.findUnique({
      where: { id: dailyChallengeId },
      include: { word: true },
    });

    if (!challenge) {
      throw new BadRequestException('Challenge not found');
    }

    // Serialize the check-then-create under an advisory lock so concurrent
    // submissions cannot both pass the "already solved" gate.
    const identityKey = userId ?? guestSessionId ?? '';
    const lockKey = BigInt('0x' + createHash('sha256').update(`daily-submit:${dailyChallengeId}:${identityKey}`).digest('hex').slice(0, 15));

    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      const challenge = await tx.dailyChallenge.findUnique({
        where: { id: dailyChallengeId },
        include: { word: true },
      });
      if (!challenge) throw new BadRequestException('Challenge not found');

      const normalized = normalizeGuess(answer);
      const synonyms = (challenge.word.synonyms as string[]) ?? [];
      const correct = validateGuess(answer, challenge.word.canonical, synonyms);

      const whereCondition: any = {
        dailyChallengeId,
        correct: true,
      };
      if (userId) whereCondition.userId = userId;
      else if (guestSessionId) whereCondition.guestSessionId = guestSessionId;

      const existingAttempt = await tx.dailyChallengeAttempt.findFirst({
        where: whereCondition,
      });
      if (existingAttempt) throw new BadRequestException('Already solved today');

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

      return { attempt, correct };
    });
  }

  private async updateStreak(userId: string, tx?: any) {
    const client = tx ?? this.prisma;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

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

    const lastPlayed = new Date(existing.lastPlayedAt);
    lastPlayed.setHours(0, 0, 0, 0);

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
