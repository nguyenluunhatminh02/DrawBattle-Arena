import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class MatchService {
  constructor(private readonly prisma: PrismaService) {}

  async listMatches(limit: number, offset: number) {
    const matches = await this.prisma.match.findMany({
      where: {
        status: 'FINISHED',
        // P1-05: public history must only enumerate public rooms. UNLISTED
        // rooms are reachable by direct link but must stay out of listings.
        room: { visibility: 'PUBLIC' },
      },
      orderBy: { endedAt: 'desc' },
      take: Math.min(limit, 50),
      skip: offset,
      include: {
        scores: {
          include: { player: { select: { id: true, nicknameSnapshot: true } } },
          orderBy: { points: 'desc' },
        },
        room: { select: { code: true } },
      },
    });

    return {
      matches: matches.map(m => ({
        id: m.id,
        roomCode: m.room.code,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        rankings: m.scores.map((s, idx) => ({
          playerId: s.player.id,
          nickname: s.player.nicknameSnapshot,
          points: s.points,
          rank: idx + 1,
        })),
      })),
    };
  }

  async getMatch(id: string) {
    const match = await this.prisma.match.findUnique({
      where: { id },
      include: {
        scores: {
          include: { player: { select: { id: true, nicknameSnapshot: true } } },
          orderBy: { points: 'desc' },
        },
        room: { select: { code: true, visibility: true } },
        rounds: {
          include: {
            turns: {
              include: { word: { select: { canonical: true, difficulty: true } } },
              orderBy: { startsAt: 'asc' },
            },
          },
          orderBy: { cycleNo: 'asc' },
        },
      },
    });
    if (!match) throw new NotFoundException('Match not found');
    if (match.room.visibility === 'PRIVATE') throw new NotFoundException('Match not found');

    return {
      id: match.id,
      roomCode: match.room.code,
      startedAt: match.startedAt,
      endedAt: match.endedAt,
      status: match.status,
      rounds: match.rounds.map(r => ({
        cycleNo: r.cycleNo,
        turns: r.turns.map(t => ({
          id: t.id,
          // Never expose the answer to anonymous callers. Private rooms keep
          // their secret word even after the match has finished.
          difficulty: t.word.difficulty,
          drawerId: t.drawerId,
          status: t.status,
          result: t.result,
        })),
      })),
      rankings: match.scores.map((s, idx) => ({
        playerId: s.player.id,
        nickname: s.player.nicknameSnapshot,
        points: s.points,
        rank: idx + 1,
      })),
    };
  }

  async getMatchResults(id: string) {
    const match = await this.prisma.match.findUnique({
      where: { id },
      include: {
        scores: {
          include: { player: { select: { id: true, nicknameSnapshot: true } } },
          orderBy: { points: 'desc' },
        },
        room: { select: { code: true, visibility: true } },
      },
    });
    if (!match) throw new NotFoundException('Match not found');
    if (match.room.visibility === 'PRIVATE') throw new NotFoundException('Match not found');

    const rankings = match.scores.map((s, idx) => ({
      playerId: s.player.id,
      nickname: s.player.nicknameSnapshot,
      points: s.points,
      rank: idx + 1,
    }));

    const duration = match.endedAt && match.startedAt
      ? match.endedAt.getTime() - match.startedAt.getTime()
      : 0;

    return {
      matchId: match.id,
      roomCode: match.room.code,
      rankings,
      duration,
      endedAt: match.endedAt,
    };
  }

  async getMyMatches(identity: { userId: string | null; guestSessionId: string | null }) {
    const { userId, guestSessionId } = identity;
    if (!userId && !guestSessionId) return { matches: [] };

    // Joining a room is not participation: only a persisted score means the
    // player actually took part in the match. Scores are tied to RoomPlayer,
    // which is the single place both guest and account identities are stored.
    const identityFilter = {
      ...(userId ? { userId } : {}),
      ...(guestSessionId ? { guestSessionId } : {}),
    };
    const scoredPlayerIds = await this.prisma.roomPlayer.findMany({
      where: identityFilter,
      select: { id: true },
    });
    const playerIds = scoredPlayerIds.map(p => p.id);
    if (playerIds.length === 0) return { matches: [] };

    const matches = await this.prisma.match.findMany({
      where: {
        status: 'FINISHED',
        scores: { some: { playerId: { in: playerIds } } },
      },
      orderBy: { endedAt: 'desc' },
      take: 20,
      include: {
        scores: {
          include: { player: { select: { id: true, nicknameSnapshot: true } } },
          orderBy: { points: 'desc' },
        },
        room: { select: { code: true } },
      },
    });

    return {
      matches: matches.map(m => ({
        id: m.id,
        roomCode: m.room.code,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        rankings: m.scores.map((s, idx) => ({
          playerId: s.player.id,
          nickname: s.player.nicknameSnapshot,
          points: s.points,
          rank: idx + 1,
        })),
      })),
    };
  }
}
