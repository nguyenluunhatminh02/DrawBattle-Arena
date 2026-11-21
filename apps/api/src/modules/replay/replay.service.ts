import {
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { verify } from 'jsonwebtoken';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { basename, join } from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { ReplayJobService } from './replay-jobs';
import {
  replayFileUrl,
  replayGifFilename,
  replayRenderDir,
} from './replay-paths';

/**
 * Per-request information used by the replay visibility check. The controller
 * passes the raw Authorization header and the optional share token from the
 * query string or a header; nothing here is trusted until it is verified.
 */
export interface ReplayReadContext {
  authorization?: string;
  shareToken?: string | string[];
}

interface ReplayIdentity {
  userId?: string;
  guestSessionId?: string;
}

/**
 * Only the relations needed to decide visibility. All fields are optional so
 * a plain replay row (or a test double) fails closed instead of accidentally
 * granting access.
 */
export interface ReplayVisibility {
  id?: string;
  turn?: {
    round?: {
      match?: {
        room?: { id: string; code: string; visibility: string } | null;
      } | null;
    } | null;
  } | null;
  challenge?: {
    creatorId: string | null;
    creatorSessionId: string | null;
  } | null;
}

const MAX_SHARE_TOKEN_LENGTH = 4096;

/**
 * Relation shape shared by the read queries. The room's visibility is the
 * authoritative policy source; a challenge replay has no room and is limited
 * to its creator.
 */
const VISIBILITY_RELATIONS = {
  turn: {
    select: {
      round: {
        select: {
          match: {
            select: {
              room: { select: { id: true, code: true, visibility: true } },
            },
          },
        },
      },
    },
  },
  challenge: { select: { creatorId: true, creatorSessionId: true } },
};

@Injectable()
export class ReplayService {
  private readonly logger = new Logger(ReplayService.name);
  private readonly renderDir = replayRenderDir();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ReplayJobService,
  ) {}

  /**
   * PUBLIC replays are readable by anyone. UNLISTED replays additionally
   * require a valid share/room token or an authenticated room participant.
   * PRIVATE replays require a participant (or the challenge creator). Every
   * denial is a 404 so callers cannot distinguish "missing" from "forbidden".
   */
  async assertReplayAccess(
    replay: ReplayVisibility | null | undefined,
    context?: ReplayReadContext,
  ): Promise<void> {
    if (!replay) throw new NotFoundException('Replay not found');

    const room = replay.turn?.round?.match?.room ?? null;
    if (room) {
      if (room.visibility === 'PUBLIC') return;

      if (
        room.visibility === 'UNLISTED' &&
        this.matchesShareToken(context, room.code)
      ) {
        return;
      }

      const identity = this.identityFromContext(context);
      if (await this.isRoomParticipant(room.id, identity)) return;

      // PRIVATE is participant-only; UNLISTED is link- or participant-only.
      throw new NotFoundException('Replay not found');
    }

    // Quick Challenge replays have no room. Only the creator may read them
    // through the replay endpoints; the challenge endpoint owns the public
    // surface for a finalized challenge.
    const challenge = replay.challenge;
    const identity = this.identityFromContext(context);
    if (
      challenge &&
      ((identity.userId && challenge.creatorId === identity.userId) ||
        (identity.guestSessionId &&
          challenge.creatorSessionId === identity.guestSessionId))
    ) {
      return;
    }

    throw new NotFoundException('Replay not found');
  }

  private identityFromContext(context?: ReplayReadContext): ReplayIdentity {
    const header = context?.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return {};
    const token = header.slice(7).trim();
    const secret = process.env.JWT_SECRET;
    if (!token || !secret) return {};
    try {
      const payload = verify(token, secret, { algorithms: ['HS256'] }) as {
        type?: unknown;
        sub?: unknown;
      };
      if (typeof payload.sub !== 'string' || !payload.sub) return {};
      if (payload.type === 'user') return { userId: payload.sub };
      if (payload.type === 'guest') return { guestSessionId: payload.sub };
    } catch {
      // Invalid, expired or wrong-type tokens are treated as anonymous.
    }
    return {};
  }

  /**
   * A share link carries the room code: either literally (`?share=CODE` /
   * `X-Share-Token: CODE`) or as a signed `{ type: 'share', roomCode }` JWT.
   * A signed token is only useful when its room code matches this replay.
   */
  private matchesShareToken(
    context: ReplayReadContext | undefined,
    roomCode: string,
  ): boolean {
    const raw = context?.shareToken;
    const candidates = Array.isArray(raw) ? raw : [raw];
    const expected = roomCode.trim().toUpperCase();
    const secret = process.env.JWT_SECRET;
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const value = candidate.trim();
      if (!value || value.length > MAX_SHARE_TOKEN_LENGTH) continue;
      if (value.toUpperCase() === expected) return true;
      if (value.split('.').length !== 3 || !secret) continue;
      try {
        const payload = verify(value, secret, { algorithms: ['HS256'] }) as {
          type?: unknown;
          roomCode?: unknown;
        };
        if (
          payload.type === 'share' &&
          typeof payload.roomCode === 'string' &&
          payload.roomCode.trim().toUpperCase() === expected
        ) {
          return true;
        }
      } catch {
        // A malformed token is simply not a valid share link.
      }
    }
    return false;
  }

  private async isRoomParticipant(
    roomId: string,
    identity: ReplayIdentity,
  ): Promise<boolean> {
    const where = identity.userId
      ? { roomId, userId: identity.userId }
      : identity.guestSessionId
        ? { roomId, guestSessionId: identity.guestSessionId }
        : null;
    if (!where) return false;
    const player = await this.prisma.roomPlayer.findFirst({
      where,
      select: { id: true },
    });
    return !!player;
  }

  /** Strip relations so the response keeps the original replay row shape. */
  private toPublicReplay<T extends ReplayVisibility>(replay: T) {
    const { turn, challenge, ...row } = replay as T & ReplayVisibility;
    return row;
  }

  async getReplay(replayId: string, context?: ReplayReadContext) {
    const replay = await this.prisma.replay.findUnique({
      where: { id: replayId },
      include: VISIBILITY_RELATIONS,
    });
    if (!replay) throw new NotFoundException('Replay not found');
    await this.assertReplayAccess(replay, context);
    return this.toPublicReplay(replay);
  }

  async getReplayByTurn(turnId: string, context?: ReplayReadContext) {
    const replay = await this.prisma.replay.findUnique({
      where: { turnId },
      include: VISIBILITY_RELATIONS,
    });
    if (!replay) throw new NotFoundException('Replay not found for turn');
    await this.assertReplayAccess(replay, context);
    return this.toPublicReplay(replay);
  }

  /** Rendering is a read of the replay content and needs the same authorization. */
  async queueRender(replayId: string, context?: ReplayReadContext) {
    await this.assertAccessByReplayId(replayId, context);
    return this.jobs.queueReplay(replayId);
  }

  async getJobStatus(jobId: string, context?: ReplayReadContext) {
    const status = await this.jobs.getStatus(jobId);
    // A job snapshot exposes gifUrl and replayId, so it needs the same check.
    if (status?.replayId) {
      await this.assertAccessByReplayId(status.replayId, context);
    }
    return status;
  }

  async getRenderStatus(replayId: string, context?: ReplayReadContext) {
    await this.assertAccessByReplayId(replayId, context);
    return this.jobs.getStatusByReplay(replayId);
  }

  private async assertAccessByReplayId(
    replayId: string,
    context?: ReplayReadContext,
  ) {
    const replay = await this.prisma.replay.findUnique({
      where: { id: replayId },
      select: { id: true, ...VISIBILITY_RELATIONS },
    });
    await this.assertReplayAccess(replay, context);
  }

  async getGif(replayId: string, context?: ReplayReadContext) {
    const replay = await this.getReplay(replayId, context);
    const job = await this.jobs.getJobByReplay(replayId);
    this.jobs.assertRendered(replay, job);
    return replayFileUrl(replayId);
  }

  /**
   * Streams the GIF only after the replay visibility check succeeds. The stored
   * pointer is ignored: the filename is derived from the authorized replay id,
   * so a tampered row cannot point at another file.
   */
  async streamGif(
    replayId: string,
    context?: ReplayReadContext,
  ): Promise<StreamableFile> {
    const replay = await this.getReplay(replayId, context);
    const job = await this.jobs.getJobByReplay(replayId);
    this.jobs.assertRendered(replay, job);

    const filename = replayGifFilename(replayId);
    if (filename !== basename(filename) || !/^[A-Za-z0-9_-]+\.gif$/.test(filename)) {
      throw new NotFoundException('Replay GIF not found');
    }
    const filepath = join(this.renderDir, filename);
    try {
      const info = await stat(filepath);
      if (!info.isFile()) throw new NotFoundException('Replay GIF not found');
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw new NotFoundException('Replay GIF not found');
    }
    return new StreamableFile(createReadStream(filepath), {
      type: 'image/gif',
      disposition: `inline; filename="${filename}"`,
    });
  }

  async updateGifUrl(replayId: string, gifUrl: string) {
    return this.prisma.replay.update({
      where: { id: replayId },
      data: { gifUrl },
    });
  }

  async getStats() {
    const total = await this.prisma.replay.count();
    const rendered = await this.prisma.replay.count({ where: { gifUrl: { not: null } } });
    return {
      total,
      rendered,
      pending: await this.jobs.pendingCount(),
      unrendered: total - rendered,
    };
  }
}
