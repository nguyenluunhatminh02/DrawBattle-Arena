import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { MatchService } from './match.service';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import type { Request } from 'express';

interface IdentityRequest extends Request {
  guest?: { sessionId: string; nickname: string };
  user?: { id: string; nickname?: string };
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
  @UseGuards(OptionalAuthGuard)
  myMatches(@Req() req: IdentityRequest) {
    const userId = req.user?.id ?? null;
    const guestSessionId = req.guest?.sessionId ?? null;
    // OptionalAuth never rejects; require a real identity so scores cannot be
    // enumerated anonymously, and treat an unrelated token as unauthenticated.
    if (!userId && !guestSessionId) {
      throw new UnauthorizedException('Guest or user token required');
    }
    return this.matchService.getMyMatches({ userId, guestSessionId });
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
