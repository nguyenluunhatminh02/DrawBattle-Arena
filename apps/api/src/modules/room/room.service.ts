import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, timingSafeEqual } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { generateRoomCode, getModeConfig, GAME_CONSTANTS } from '@drawbattle/shared';
import type { RoomSettings } from '@drawbattle/shared';

/**
 * New room passwords use bcrypt. The legacy salted SHA-256 format is still
 * accepted so rooms created before the upgrade remain joinable.
 */
async function hashRoomPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

function legacyPasswordHash(password: string): string {
  return createHash('sha256').update(`room-pwd:${password}`).digest('hex');
}

async function verifyRoomPassword(
  password: string | undefined,
  hash: string | undefined,
): Promise<boolean> {
  if (!hash) return true;
  if (!password) return false;
  if (hash.startsWith('$2')) return bcrypt.compare(password, hash);

  const expected = legacyPasswordHash(password);
  if (hash.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(hash, 'utf8'), Buffer.from(expected, 'utf8'));
}

const DEFAULT_SETTINGS: RoomSettings = {
  maxPlayers: 8,
  rounds: 2,
  turnDuration: 60,
  difficulty: 'MIXED',
  language: 'vi',
  enableHints: true,
  enableGuests: true,
  mode: 'CLASSIC',
};

/** Bounded retry budget for PostgreSQL Serializable write conflicts. */
const SERIALIZABLE_RETRY_ATTEMPTS = 3;
const SERIALIZABLE_RETRY_BASE_DELAY_MS = 10;

function isSerializableConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'P2034') return true;
  // Prisma maps SQLSTATE 40001 to P2034 in current versions; keep the raw
  // code as a fallback for older clients and for wrapped driver errors.
  return (err as { meta?: { code?: unknown } }).meta?.code === '40001';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retries only retryable Serializable conflicts; validation/domain exceptions
 * and all other database failures are surfaced immediately. Concurrent joins
 * re-read room membership and capacity on every attempt.
 */
async function withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < SERIALIZABLE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (!isSerializableConflict(err) || attempt === SERIALIZABLE_RETRY_ATTEMPTS - 1) {
        throw err;
      }
      await sleep(SERIALIZABLE_RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error('Serializable retry budget exhausted');
}

@Injectable()
export class RoomService {
  constructor(private readonly prisma: PrismaService) {}

  async createRoom(
    hostNickname: string,
    hostSessionId: string | null,
    hostUserId: string | null,
    settings?: Partial<RoomSettings>,
  ) {
    const merged: RoomSettings = { ...DEFAULT_SETTINGS, ...settings };
    if (merged.password) {
      (merged as any).passwordHash = await hashRoomPassword(merged.password);
      delete (merged as any).password;
    }
    const modeConfig = getModeConfig(merged.mode);
    const finalSettings: RoomSettings = {
      ...merged,
      maxPlayers:
        merged.mode === 'DUEL'
          ? 2
          : Math.min(Math.max(merged.maxPlayers, modeConfig.minPlayers), modeConfig.maxPlayers),
      rounds: merged.mode === 'DUEL' ? modeConfig.rounds : merged.rounds,
      turnDuration:
        merged.mode === 'SPEED' || merged.mode === 'DUEL'
          ? modeConfig.turnDuration
          : merged.turnDuration,
    };
    let code = '';
    let attempts = 0;
    while (attempts < 10) {
      code = generateRoomCode();
      const existing = await this.prisma.room.findUnique({ where: { code } });
      if (!existing) break;
      attempts++;
    }
    if (attempts >= 10) {
      throw new ConflictException('Could not generate unique room code');
    }

    return this.prisma.$transaction(async (tx) => {
      const room = await tx.room.create({
        data: {
          code,
          settings: finalSettings as unknown as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + GAME_CONSTANTS.ROOM_TTL_MS),
        },
      });

      const hostPlayer = await tx.roomPlayer.create({
        data: {
          roomId: room.id,
          userId: hostUserId,
          guestSessionId: hostSessionId,
          nicknameSnapshot: hostNickname,
          role: 'HOST',
        },
      });

      await tx.room.update({
        where: { id: room.id },
        data: { hostPlayerId: hostPlayer.id },
      });

      return {
        roomId: room.id,
        roomCode: code,
        playerId: hostPlayer.id,
      };
    });
  }

  async getRoomInfo(code: string) {
    const room = await this.prisma.room.findUnique({
      where: { code },
      include: {
        players: { where: { leftAt: null }, include: { user: true, guest: true } },
      },
    });
    if (!room) throw new NotFoundException('Room not found');
    const settings = room.settings as unknown as RoomSettings & { passwordHash?: string };
    const hasPassword = Boolean(settings.passwordHash);
    const { password: _p, passwordHash: _h, ...safeSettings } = settings;
    return {
      id: room.id,
      code: room.code,
      status: room.status,
      playerCount: room.players.length,
      maxPlayers: settings.maxPlayers,
      hasPassword,
      settings: safeSettings,
    };
  }

  async joinRoom(
    code: string,
    nickname: string,
    guestSessionId: string | null,
    userId: string | null,
    password?: string,
  ) {
    return withSerializableRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const room = await tx.room.findUnique({
          where: { code },
          include: { players: true },
        });
        if (!room) throw new NotFoundException('Room not found');
        if (room.expiresAt && room.expiresAt < new Date()) {
          throw new BadRequestException('Room expired');
        }

        // DB is authoritative for kicks: a banned identity must never be able to
        // create or reactivate a RoomPlayer, including after restarts or when a
        // different API process handles the join.
        const identities: Prisma.RoomBanWhereInput[] = [];
        if (userId) identities.push({ userId });
        if (guestSessionId) identities.push({ guestSessionId });
        if (
          identities.length > 0 &&
          (await tx.roomBan.findFirst({
            where: { roomId: room.id, OR: identities },
            select: { id: true },
          }))
        ) {
          throw new ForbiddenException('You were kicked from this room');
        }

        const settings = room.settings as unknown as RoomSettings & { passwordHash?: string };

        // A reconnecting player is still subject to the room password. Checking
        // this before the early return prevents password-free rejoin while the
        // disconnect grace timer has not yet persisted leftAt.
        if (settings.passwordHash && !(await verifyRoomPassword(password, settings.passwordHash))) {
          throw new BadRequestException('Invalid password');
        }

        const activePlayers = room.players.filter(p => !p.leftAt);
        const existing = room.players.find(
          p =>
            (userId && p.userId === userId) ||
            (guestSessionId && p.guestSessionId === guestSessionId),
        );
        // Allow reconnects during active matches - return existing player immediately
        if (existing && !existing.leftAt) {
          return {
            roomId: room.id,
            roomCode: room.code,
            playerId: existing.id,
          };
        }

        // Only check room status for genuinely new joins
        if (room.status !== 'WAITING') {
          throw new BadRequestException('Game already in progress');
        }

        if (activePlayers.length >= settings.maxPlayers) {
          throw new BadRequestException('Room is full');
        }

        if (existing && existing.leftAt) {
          const reactivated = await tx.roomPlayer.update({
            where: { id: existing.id },
            data: { leftAt: null, nicknameSnapshot: nickname },
          });
          return {
            roomId: room.id,
            roomCode: room.code,
            playerId: reactivated.id,
          };
        }

        if (!nickname || nickname.trim().length === 0) {
          throw new BadRequestException('Nickname is required');
        }
        const player = await tx.roomPlayer.create({
          data: {
            roomId: room.id,
            userId,
            guestSessionId,
            nicknameSnapshot: nickname,
            role: 'PLAYER',
          },
        });

        return {
          roomId: room.id,
          roomCode: room.code,
          playerId: player.id,
        };
      }, {
        isolationLevel: 'Serializable',
        maxWait: 5000,
        timeout: 10000,
      }),
    );
  }

  async getRoomById(id: string) {
    const room = await this.prisma.room.findUnique({
      where: { id },
      include: {
        players: { where: { leftAt: null }, orderBy: { joinedAt: 'asc' } },
      },
    });
    if (!room) throw new NotFoundException('Room not found');
    return room;
  }

  async resetRoomStatus(id: string) {
    await this.prisma.room.update({
      where: { id },
      data: { status: 'WAITING' },
    });
  }

  /**
   * Persists a kick ban for the target's durable identities. Resolves them from
   * the RoomPlayer row in the DB, never from socket state, so offline targets
   * and socket/session rotation cannot evade the ban. Must be called before
   * the target is removed from the in-memory game state.
   */
  async banPlayer(roomId: string, targetRoomPlayerId: string) {
    const player = await this.prisma.roomPlayer.findFirst({
      where: { id: targetRoomPlayerId, roomId },
      select: { userId: true, guestSessionId: true },
    });
    if (!player) throw new NotFoundException('Room player not found');

    await this.prisma.$transaction(async tx => {
      if (player.userId) {
        await tx.roomBan.upsert({
          where: { roomId_userId: { roomId, userId: player.userId } },
          create: { roomId, userId: player.userId },
          update: {},
        });
      }
      if (player.guestSessionId) {
        await tx.roomBan.upsert({
          where: { roomId_guestSessionId: { roomId, guestSessionId: player.guestSessionId } },
          create: { roomId, guestSessionId: player.guestSessionId },
          update: {},
        });
      }
    });

    return { userId: player.userId, guestSessionId: player.guestSessionId };
  }

  /**
   * A leave is a single durable transition: marking the player as left,
   * recounting active members and resetting an empty room must all commit
   * together. A rejected write therefore never leaves a room half-updated.
   */
  async leaveRoom(roomId: string, playerId: string) {
    return withSerializableRetry(() =>
      this.prisma.$transaction(async tx => {
        await tx.roomPlayer.update({
          where: { id: playerId, roomId },
          data: { leftAt: new Date() },
        });
        const activeCount = await tx.roomPlayer.count({
          where: { roomId, leftAt: null },
        });
        if (activeCount === 0) {
          await tx.room.update({
            where: { id: roomId },
            data: { status: 'WAITING', hostPlayerId: null },
          });
        }
        return { activeCount };
      }, {
        isolationLevel: 'Serializable',
        maxWait: 5000,
        timeout: 10000,
      }),
    );
  }

  async updateHost(roomId: string, hostPlayerId: string) {
    await this.prisma.room.update({
      where: { id: roomId },
      data: { hostPlayerId },
    });
  }
}
