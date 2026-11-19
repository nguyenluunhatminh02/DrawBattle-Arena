import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { generateRoomCode, getModeConfig, GAME_CONSTANTS } from '@drawbattle/shared';
import type { RoomSettings } from '@drawbattle/shared';

function hashRoomPassword(password: string): string {
  return createHash('sha256').update(`room-pwd:${password}`).digest('hex');
}

function verifyRoomPassword(password: string | undefined, hash: string | undefined): boolean {
  if (!hash) return true;
  if (!password) return false;
  return hashRoomPassword(password) === hash;
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
      (merged as any).passwordHash = hashRoomPassword(merged.password);
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
        players: { include: { user: true, guest: true } },
      },
    });
    if (!room) throw new NotFoundException('Room not found');
    const settings = room.settings as unknown as RoomSettings;
    const hasPassword = Boolean(settings.password);
    const { password: _unused, ...safeSettings } = settings;
    return {
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
    return this.prisma.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { code },
        include: { players: true },
      });
      if (!room) throw new NotFoundException('Room not found');
      if (room.expiresAt && room.expiresAt < new Date()) {
        throw new BadRequestException('Room expired');
      }

      const existing = room.players.find(
        p =>
          (userId && p.userId === userId) ||
          (guestSessionId && p.guestSessionId === guestSessionId),
      );
      if (existing) {
        return {
          roomId: room.id,
          roomCode: room.code,
          playerId: existing.id,
        };
      }

      if (room.status !== 'WAITING') {
        throw new BadRequestException('Game already in progress');
      }
      const settings = room.settings as unknown as RoomSettings & { passwordHash?: string };
      if (settings.passwordHash && !verifyRoomPassword(password, settings.passwordHash)) {
        throw new BadRequestException('Invalid password');
      }
      if (room.players.length >= settings.maxPlayers) {
        throw new BadRequestException('Room is full');
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
    });
  }

  async getRoomById(id: string) {
    const room = await this.prisma.room.findUnique({
      where: { id },
      include: {
        players: { orderBy: { joinedAt: 'asc' } },
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

  async updateHost(roomId: string, hostPlayerId: string) {
    await this.prisma.room.update({
      where: { id: roomId },
      data: { hostPlayerId },
    });
  }
}
