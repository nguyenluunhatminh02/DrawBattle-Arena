import { NotFoundException } from '@nestjs/common';
import { MatchService } from './match.service';

describe('MatchService public visibility', () => {
  const finishedMatch = (visibility: 'PRIVATE' | 'PUBLIC' | 'UNLISTED') => ({
    id: `match-${visibility}`,
    room: { code: `CODE-${visibility}`, visibility },
    startedAt: new Date('2026-11-20T10:00:00Z'),
    endedAt: new Date('2026-11-20T10:05:00Z'),
    status: 'FINISHED',
    scores: [],
  });

  it('excludes PRIVATE rooms from public match history', async () => {
    const findMany = jest.fn().mockResolvedValue([finishedMatch('PUBLIC')]);
    const service = new MatchService({ match: { findMany } } as never);

    const result = await service.listMatches(20, 0);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'FINISHED',
          room: { visibility: { in: ['PUBLIC', 'UNLISTED'] } },
        },
      }),
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].roomCode).toBe('CODE-PUBLIC');
  });

  it('does not expose PRIVATE match details or results', async () => {
    const findUnique = jest.fn().mockResolvedValue(finishedMatch('PRIVATE'));
    const service = new MatchService({ match: { findUnique } } as never);

    await expect(service.getMatch('match-PRIVATE')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getMatchResults('match-PRIVATE')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('filters my matches by scored participation, not rooms joined', async () => {
    const roomPlayerFindMany = jest.fn().mockResolvedValue([{ id: 'rp-1' }]);
    const matchFindMany = jest.fn().mockResolvedValue([]);
    const service = new MatchService({
      roomPlayer: { findMany: roomPlayerFindMany },
      match: { findMany: matchFindMany },
    } as never);

    const result = await service.getMyMatches({ userId: 'user-1', guestSessionId: null });

    expect(roomPlayerFindMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: { id: true },
    });
    expect(matchFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'FINISHED',
          scores: { some: { playerId: { in: ['rp-1'] } } },
        },
      }),
    );
    expect(result).toEqual({ matches: [] });
  });

  it('returns no matches when neither identity is present', async () => {
    const roomPlayerFindMany = jest.fn();
    const matchFindMany = jest.fn();
    const service = new MatchService({
      roomPlayer: { findMany: roomPlayerFindMany },
      match: { findMany: matchFindMany },
    } as never);

    const result = await service.getMyMatches({ userId: null, guestSessionId: null });

    expect(result).toEqual({ matches: [] });
    expect(roomPlayerFindMany).not.toHaveBeenCalled();
    expect(matchFindMany).not.toHaveBeenCalled();
  });
});
