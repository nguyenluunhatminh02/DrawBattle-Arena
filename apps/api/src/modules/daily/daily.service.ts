import { Injectable, BadRequestException } from '@nestjs/common';
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

    const existing = await this.prisma.dailyChallenge.findUnique({
      where: { date: today },
    });

    if (existing) {
      return;
    }

    const randomWord = await this.prisma.word.findFirst({
      where: { active: true },
      orderBy: { usageCount: 'asc' },
    });

    if (!randomWord) {
      throw new Error('No active words available');
    }

    await this.prisma.dailyChallenge.create({
      data: {
        date: today,
        wordId: randomWord.id,
      },
    });

    await this.prisma.word.update({
      where: { id: randomWord.id },
      data: { usageCount: { increment: 1 } },
    });
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

    const normalized = normalizeGuess(answer);
    const synonyms = (challenge.word.synonyms as string[]) ?? [];
    const correct = validateGuess(answer, challenge.word.canonical, synonyms);

    const whereCondition: any = {
      dailyChallengeId,
      correct: true,
    };

    if (userId) {
      whereCondition.userId = userId;
    } else if (guestSessionId) {
      whereCondition.guestSessionId = guestSessionId;
    }

    const existingAttempt = await this.prisma.dailyChallengeAttempt.findFirst({
      where: whereCondition,
    });

    if (existingAttempt) {
      throw new BadRequestException('Already solved today');
    }

    const attempt = await this.prisma.dailyChallengeAttempt.create({
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
      await this.updateStreak(userId);
    }

    return { attempt, correct };
  }

  private async updateStreak(userId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let streak = await this.prisma.streak.findUnique({ where: { userId } });

    if (!streak) {
      streak = await this.prisma.streak.create({
        data: {
          userId,
          currentStreak: 1,
          longestStreak: 1,
          lastPlayedAt: today,
        },
      });
      return streak;
    }

    const lastPlayed = new Date(streak.lastPlayedAt);
    lastPlayed.setHours(0, 0, 0, 0);

    let newStreak = streak.currentStreak;

    if (lastPlayed.getTime() === today.getTime()) {
      return streak;
    } else if (lastPlayed.getTime() === yesterday.getTime()) {
      newStreak = streak.currentStreak + 1;
    } else {
      newStreak = 1;
    }

    const longestStreak = Math.max(streak.longestStreak, newStreak);

    return this.prisma.streak.update({
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
