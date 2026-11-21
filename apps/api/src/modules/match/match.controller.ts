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
import { Throttle } from '../../common/throttle.guard';
import type { Request } from 'express';

interface IdentityRequest extends Request {
  guest?: { sessionId: string; nickname: string };
  user?: { id: string; nickname?: string };
}

@Controller('matches')
export class MatchController {
  constructor(private readonly matchService: MatchService) {}

  @Get()
  @Throttle({ limit: 60, windowMs: 60_000, keyPrefix: 'match-list' })
  list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    // Clamp client input here as well as in the service: negative/NaN offsets
    // can otherwise skip arbitrary rows or turn into invalid Prisma queries.
    const parsedLimit = Number.parseInt(limit ?? '20', 10);
    const parsedOffset = Number.parseInt(offset ?? '0', 10);
    const take = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50) : 20;
    const skip = Number.isFinite(parsedOffset) && parsedOffset > 0 ? Math.min(parsedOffset, 10_000) : 0;
    return this.matchService.listMatches(take, skip);
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
  @Throttle({ limit: 120, windowMs: 60_000, keyPrefix: 'match-detail' })
  details(@Param('id') id: string) {
    return this.matchService.getMatch(id);
  }

  @Get(':id/results')
  @Throttle({ limit: 120, windowMs: 60_000, keyPrefix: 'match-results' })
  results(@Param('id') id: string) {
    return this.matchService.getMatchResults(id);
  }
}
