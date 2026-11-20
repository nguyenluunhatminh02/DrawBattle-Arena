import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class MatchService {
  constructor(private readonly prisma: PrismaService) {}

  async listMatches(limit: number, offset: number) {
    const matches = await this.prisma.match.findMany({
      where: {
        status: 'FINISHED',
        // Public history must never enumerate PRIVATE room codes.
        room: { visibility: { in: ['PUBLIC', 'UNLISTED'] } },
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

  async getMyMatches(guestSessionId: string) {
    const roomPlayers = await this.prisma.roomPlayer.findMany({
      where: { guestSessionId },
      select: { roomId: true },
    });
    const roomIds = roomPlayers.map(p => p.roomId);
    if (roomIds.length === 0) return { matches: [] };

    const matches = await this.prisma.match.findMany({
      where: { roomId: { in: roomIds }, status: 'FINISHED' },
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
