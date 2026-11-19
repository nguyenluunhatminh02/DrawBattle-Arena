import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ChallengeService } from './challenge.service';
import { Throttle } from '../../common/throttle.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import type { WordDifficulty } from '@drawbattle/shared';
import type { Identity } from './challenge.service';

@Controller('challenges')
export class ChallengeController {
  constructor(private readonly challenge: ChallengeService) {}

  @Post()
  @UseGuards(OptionalAuthGuard)
  @Throttle({ limit: 10, windowMs: 60_000, keyPrefix: 'challenge-create' })
  create(@Body() body: { difficulty?: WordDifficulty; category?: string; wordId?: string }, @Req() req: any) {
    const creator: Identity = {
      userId: req.user?.id,
      sessionId: req.guest?.sessionId,
    };
    return this.challenge.create(body, creator);
  }

  @Post(':id/finalize')
  @UseGuards(OptionalAuthGuard)
  finalize(
    @Param('id') id: string,
    @Req() req: any,
    @Body()
    body: {
      strokes: Array<{
        strokeId: string;
        points: Array<{ x: number; y: number }>;
        color: string;
        width: number;
      }>;
      durationMs: number;
    },
  ) {
    const actor: Identity = {
      userId: req.user?.id,
      sessionId: req.guest?.sessionId,
    };
    return this.challenge.finalize(id, body.strokes, body.durationMs, actor);
  }

  @Get(':id')
  @UseGuards(OptionalAuthGuard)
  info(@Param('id') id: string, @Req() req: any) {
    const solver: Identity = {
      userId: req.user?.id,
      sessionId: req.guest?.sessionId,
    };
    return this.challenge.getInfo(id, solver);
  }

  @Post(':id/guesses')
  @UseGuards(OptionalAuthGuard)
  @Throttle({ limit: 10, windowMs: 30_000, keyPrefix: 'challenge-guess' })
  submitGuess(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { answer: string },
  ) {
    const solver: Identity = {
      userId: req.user?.id,
      sessionId: req.guest?.sessionId,
    };
    return this.challenge.submitGuess(id, body.answer, solver);
  }
}
