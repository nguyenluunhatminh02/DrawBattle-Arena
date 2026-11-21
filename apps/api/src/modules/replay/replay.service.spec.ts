import { NotFoundException } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { ReplayService } from './replay.service';

const SECRET = 'test-secret-with-at-least-32-characters-long';

function replayWithVisibility(visibility: string) {
  return {
    id: 'replay-1',
    strokes: [],
    durationMs: 1000,
    turn: {
      round: {
        match: {
          room: { id: 'room-1', code: 'ABC123', visibility },
        },
      },
    },
    challenge: null,
  };
}

function bearer(type: string, id = 'user-1') {
  return `Bearer ${sign({ sub: id, type }, SECRET, { expiresIn: '1h' })}`;
}

function createService() {
  const roomPlayerFindFirst = jest.fn().mockResolvedValue(null);
  const prisma = {
    replay: {
      findUnique: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    roomPlayer: { findFirst: roomPlayerFindFirst },
  };
  const jobs = {
    getStatusByReplay: jest.fn().mockResolvedValue({ status: 'completed' }),
    getStatus: jest.fn(),
    getJobByReplay: jest.fn(),
    assertRendered: jest.fn(),
    queueReplay: jest.fn(),
    pendingCount: jest.fn(),
  };
  const service = new ReplayService(prisma as never, jobs as never);
  return { service, prisma, jobs, roomPlayerFindFirst };
}

describe('ReplayService visibility (P1-01)', () => {
  const originalSecret = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
  });
  afterAll(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  it('allows PUBLIC replays for anonymous callers', async () => {
    const { service, roomPlayerFindFirst } = createService();
    await expect(service.assertReplayAccess(replayWithVisibility('PUBLIC'))).resolves.toBeUndefined();
    expect(roomPlayerFindFirst).not.toHaveBeenCalled();
  });

  it('denies PRIVATE replays without a verified identity', async () => {
    const { service } = createService();
    await expect(
      service.assertReplayAccess(replayWithVisibility('PRIVATE'), {
        authorization: 'Bearer forged-token',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    // A signed token of an unrelated type must not be treated as an identity.
    await expect(
      service.assertReplayAccess(replayWithVisibility('PRIVATE'), {
        authorization: bearer('share', 'ABC123'),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows PRIVATE replays for a room participant', async () => {
    const { service, roomPlayerFindFirst } = createService();
    roomPlayerFindFirst.mockResolvedValue({ id: 'room-player-1' });

    await expect(
      service.assertReplayAccess(replayWithVisibility('PRIVATE'), {
        authorization: bearer('user'),
      }),
    ).resolves.toBeUndefined();
    expect(roomPlayerFindFirst).toHaveBeenCalledWith({
      where: { roomId: 'room-1', userId: 'user-1' },
      select: { id: true },
    });

    await expect(
      service.assertReplayAccess(replayWithVisibility('PRIVATE'), {
        authorization: bearer('guest', 'guest-1'),
      }),
    ).resolves.toBeUndefined();
    expect(roomPlayerFindFirst).toHaveBeenLastCalledWith({
      where: { roomId: 'room-1', guestSessionId: 'guest-1' },
      select: { id: true },
    });
  });

  it('allows UNLISTED replays with a share token but not with an unrelated or forged one', async () => {
    const { service } = createService();
    const signed = sign({ type: 'share', roomCode: 'ABC123' }, SECRET, { expiresIn: '1h' });
    const wrongRoom = sign({ type: 'share', roomCode: 'OTHER' }, SECRET, { expiresIn: '1h' });
    const forged = sign({ type: 'share', roomCode: 'ABC123' }, 'another-secret', { expiresIn: '1h' });

    await expect(
      service.assertReplayAccess(replayWithVisibility('UNLISTED'), { shareToken: signed }),
    ).resolves.toBeUndefined();
    await expect(
      service.assertReplayAccess(replayWithVisibility('UNLISTED'), { shareToken: 'ABC123' }),
    ).resolves.toBeUndefined();
    await expect(
      service.assertReplayAccess(replayWithVisibility('UNLISTED'), { shareToken: ' abc123 ' }),
    ).resolves.toBeUndefined();

    await expect(
      service.assertReplayAccess(replayWithVisibility('UNLISTED'), { shareToken: wrongRoom }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.assertReplayAccess(replayWithVisibility('UNLISTED'), { shareToken: forged }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('denies UNLISTED replays when neither a share token nor a participant identity is present', async () => {
    const { service } = createService();
    await expect(
      service.assertReplayAccess(replayWithVisibility('UNLISTED')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows the creator to read a challenge replay', async () => {
    const { service } = createService();
    const challengeReplay = {
      id: 'challenge-replay',
      turn: null,
      challenge: { creatorId: 'user-1', creatorSessionId: null },
    };
    await expect(
      service.assertReplayAccess(challengeReplay, { authorization: bearer('user') }),
    ).resolves.toBeUndefined();
    await expect(
      service.assertReplayAccess(challengeReplay),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('enforces the same policy for getReplay, getReplayByTurn and render status', async () => {
    const { service, prisma, jobs } = createService();
    prisma.replay.findUnique.mockResolvedValue(replayWithVisibility('PRIVATE'));

    await expect(service.getReplay('replay-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getReplayByTurn('turn-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getRenderStatus('replay-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(jobs.getStatusByReplay).not.toHaveBeenCalled();

    prisma.replay.findUnique.mockResolvedValue(replayWithVisibility('PUBLIC'));
    await expect(service.getReplay('replay-1')).resolves.toMatchObject({ id: 'replay-1' });
    await expect(service.getRenderStatus('replay-1')).resolves.toEqual({ status: 'completed' });
  });

  it('enforces visibility before streaming from the guarded GIF path', async () => {
    const { service, prisma, jobs, roomPlayerFindFirst } = createService();
    prisma.replay.findUnique.mockResolvedValue(replayWithVisibility('PRIVATE'));
    jobs.getJobByReplay.mockResolvedValue(null);
    jobs.assertRendered.mockReturnValue('/replays/replay-1.gif');

    await expect(service.getGif('replay-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(jobs.assertRendered).not.toHaveBeenCalled();

    roomPlayerFindFirst.mockResolvedValue({ id: 'room-player-1' });
    // The authorized path streams the file directly: a 302 redirect to
    // /api/replays/file/... would drop Authorization and ?share and break
    // UNLISTED/PRIVATE reads. Missing files fail closed with 404.
    await expect(service.getGif('replay-1', { authorization: bearer('user') })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(jobs.assertRendered).toHaveBeenCalled();
  });

  it('requires authorization before queueing a render (P2-03)', async () => {
    const { service, prisma, jobs, roomPlayerFindFirst } = createService();
    prisma.replay.findUnique.mockResolvedValue(replayWithVisibility('PRIVATE'));
    jobs.queueReplay.mockResolvedValue({ jobId: 'job-1', status: 'queued' });

    await expect(service.queueRender('replay-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(jobs.queueReplay).not.toHaveBeenCalled();

    roomPlayerFindFirst.mockResolvedValue({ id: 'room-player-1' });
    await expect(
      service.queueRender('replay-1', { authorization: bearer('user') }),
    ).resolves.toEqual({ jobId: 'job-1', status: 'queued' });
    expect(jobs.queueReplay).toHaveBeenCalledWith('replay-1');
  });
});
