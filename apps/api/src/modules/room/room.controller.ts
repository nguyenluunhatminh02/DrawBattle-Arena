import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { RoomService } from './room.service';
import { GuestGuard } from '../auth/guest.guard';
import { Throttle } from '../../common/throttle.guard';
import type { Request } from 'express';

interface GuestRequest extends Request {
  guest?: { sessionId: string; nickname: string };
}

@Controller('rooms')
export class RoomController {
  constructor(private readonly room: RoomService) {}

  @Post()
  @UseGuards(GuestGuard)
  @Throttle({ limit: 5, windowMs: 60_000, keyPrefix: 'room-create' })
  async create(@Body() body: { settings?: Record<string, unknown> }, @Req() req: GuestRequest) {
    const guest = req.guest!;
    const result = await this.room.createRoom(
      guest.nickname,
      guest.sessionId,
      null,
      body.settings as never,
    );
    return result;
  }

  @Get(':code')
  info(@Param('code') code: string) {
    return this.room.getRoomInfo(code);
  }

  @Post(':code/join')
  @UseGuards(GuestGuard)
  @Throttle({ limit: 10, windowMs: 60_000, keyPrefix: 'room-join' })
  async join(
    @Param('code') code: string,
    @Body() body: { password?: string },
    @Req() req: GuestRequest,
  ) {
    const guest = req.guest!;
    return this.room.joinRoom(code, guest.nickname, guest.sessionId, null, body.password);
  }
}
