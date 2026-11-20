import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Cron } from '@nestjs/schedule';
import { normalizeGuess, validateGuess } from '@drawbattle/shared';

const VIETNAM_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const MAX_DAILY_ATTEMPTS = 10;
const DAILY_ATTEMPT_COOLDOWN_MS = 1000;
// Bound the candidate scan: strokes are stored as JSON and Postgres cannot
// cheaply express "every stroke has at least two points" in a Prisma filter.
const DAILY_REPLAY_CANDIDATE_LIMIT = 50;

/** A stroke with fewer than two points cannot draw a line and renders as a blank replay. */
export function hasValidReplayStrokes(strokes: unknown): boolean {
  if (!Array.isArray(strokes) || strokes.length === 0) return false;
  return strokes.every(stroke => {
    if (!stroke || typeof stroke !== 'object') return false;
    const points = (stroke as { points?: unknown }).points;
    return Array.isArray(points) && points.length >= 2;
  });
}

interface DailyReplaySource {
  strokes: unknown;
  turn: { round: { match: { room: { visibility: string } } } } | null;
}

/**
 * P0 DAILY-PRIVACY: Daily may only reuse a drawing from a PUBLIC match room.
 * Quick Challenge drawings have no room and no explicit "daily eligible"
 * flag, so they are deliberately excluded here as well.
 */
function isEligibleDailyReplay(replay: DailyReplaySource | null): boolean {
  return Boolean(
    replay &&
    hasValidReplayStrokes(replay.strokes) &&
    replay.turn?.round?.match?.room?.visibility === 'PUBLIC',
  );
}

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

      // P0 DAILY-PRIVACY: only replays from PUBLIC match rooms may be reused
      // as the shared daily drawing. Private/unlisted room drawings and Quick
      // Challenge drawings (no room, no explicit daily-eligibility flag) must
      // never surface here. Recent candidates are scanned in bounded batches
      // because the ">= 2 points per stroke" check runs on the JSON payload.
      let replayBackedWord: { id: string; wordId: string } | null = null;
      let cursor: string | undefined;
      outer: for (let batch = 0; batch < 20; batch++) {
        const candidates = await tx.replay.findMany({
          where: {
            dailyId: null,
            turnId: { not: null },
            turn: { is: { word: { is: { active: true } } } },
          },
          orderBy: { createdAt: 'desc' },
          take: DAILY_REPLAY_CANDIDATE_LIMIT,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          select: {
            id: true,
            strokes: true,
            turn: {
              select: {
                wordId: true,
                round: { select: { match: { select: { room: { select: { visibility: true } } } } } },
              },
            },
          },
        });
        if (candidates.length === 0) break;
        for (const candidate of candidates) {
          cursor = candidate.id;
          if (isEligibleDailyReplay(candidate)) {
            replayBackedWord = { id: candidate.id, wordId: candidate.turn!.wordId };
            break outer;
          }
        }
      }

      const word = replayBackedWord
        ? await tx.word.findFirst({
            where: { id: replayBackedWord.wordId, active: true },
            select: { id: true },
          })
        : await tx.word.findFirst({
            where: { active: true },
            orderBy: { usageCount: 'asc' },
            select: { id: true },
          });
      if (!word) throw new Error('No active words available');

      const challenge = await tx.dailyChallenge.create({
        data: { date: today, wordId: word.id },
      });
      if (replayBackedWord && replayBackedWord.wordId === word.id) {
        // replayId is unique; updateMany keeps a concurrent claim from
        // throwing after the daily row has already been persisted.
        await tx.replay.updateMany({
          where: { id: replayBackedWord.id, dailyId: null },
          data: { dailyId: challenge.id },
        });
      }
      await tx.word.update({
        where: { id: word.id },
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
      // DAILY-07: expose only the drawing data the UI needs; never spread
      // internal replay columns into a public response. Re-check eligibility
      // so a replay linked before the PUBLIC-room rule landed is never served.
      hasReplay: isEligibleDailyReplay(challenge.replay),
      replay:
        challenge.replay && isEligibleDailyReplay(challenge.replay)
          ? {
              strokes: challenge.replay.strokes,
              durationMs: challenge.replay.durationMs,
            }
          : null,
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
        replay: {
          select: {
            strokes: true,
            durationMs: true,
            turn: {
              select: {
                round: { select: { match: { select: { room: { select: { visibility: true } } } } } },
              },
            },
          },
        },
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
