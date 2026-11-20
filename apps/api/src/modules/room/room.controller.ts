import { Body, Controller, Get, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { RoomService } from './room.service';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { Throttle } from '../../common/throttle.guard';
import type { Request } from 'express';

interface IdentityRequest extends Request {
  guest?: { sessionId: string; nickname: string };
  user?: { id: string; nickname?: string };
}

@Controller('rooms')
export class RoomController {
  constructor(private readonly room: RoomService) {}

  @Post()
  @UseGuards(OptionalAuthGuard)
  @Throttle({ limit: 5, windowMs: 60_000, keyPrefix: 'room-create' })
  async create(@Body() body: { settings?: Record<string, unknown> }, @Req() req: IdentityRequest) {
    if (req.user?.id) {
      return this.room.createRoom(
        req.user.nickname ?? 'Player',
        null,
        req.user.id,
        body.settings as never,
      );
    }
    if (!req.guest) {
      throw new UnauthorizedException('Guest or user token required');
    }
    const guest = req.guest;
    return this.room.createRoom(
      guest.nickname,
      guest.sessionId,
      null,
      body.settings as never,
    );
  }

  @Get(':code')
  info(@Param('code') code: string) {
    return this.room.getRoomInfo(code);
  }

  @Post(':code/join')
  @UseGuards(OptionalAuthGuard)
  @Throttle({ limit: 10, windowMs: 60_000, keyPrefix: 'room-join' })
  async join(
    @Param('code') code: string,
    @Body() body: { password?: string },
    @Req() req: IdentityRequest,
  ) {
    if (req.user?.id) {
      return this.room.joinRoom(
        code,
        req.user.nickname ?? 'Player',
        null,
        req.user.id,
        body.password,
      );
    }
    if (!req.guest) {
      throw new UnauthorizedException('Guest or user token required');
    }
    return this.room.joinRoom(code, req.guest.nickname, req.guest.sessionId, null, body.password);
  }
}
