import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { MatchService } from './match.service';
import { GuestGuard } from '../auth/guest.guard';
import type { Request } from 'express';

interface GuestRequest extends Request {
  guest?: { sessionId: string; nickname: string };
}

@Controller('matches')
export class MatchController {
  constructor(private readonly matchService: MatchService) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.matchService.listMatches(
      limit ? parseInt(limit, 10) : 20,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  @Get('me')
  @UseGuards(GuestGuard)
  myMatches(@Req() req: GuestRequest) {
    const guest = req.guest!;
    return this.matchService.getMyMatches(guest.sessionId);
  }

  @Get(':id')
  details(@Param('id') id: string) {
    return this.matchService.getMatch(id);
  }

  @Get(':id/results')
  results(@Param('id') id: string) {
    return this.matchService.getMatchResults(id);
  }
}
