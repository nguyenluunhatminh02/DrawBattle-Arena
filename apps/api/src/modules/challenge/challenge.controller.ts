import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ChallengeService } from './challenge.service';
import { Throttle } from '../../common/throttle.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import type { WordDifficulty } from '@drawbattle/shared';

@Controller('challenges')
export class ChallengeController {
  constructor(private readonly challenge: ChallengeService) {}

  @Post()
  @Throttle({ limit: 10, windowMs: 60_000, keyPrefix: 'challenge-create' })
  create(@Body() body: { difficulty?: WordDifficulty; category?: string; wordId?: string }) {
    return this.challenge.create(body);
  }

  @Post(':id/finalize')
  finalize(
    @Param('id') id: string,
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
    return this.challenge.finalize(id, body.strokes, body.durationMs);
  }

  @Get(':id')
  info(@Param('id') id: string) {
    return this.challenge.getInfo(id);
  }

  @Post(':id/guesses')
  @UseGuards(OptionalAuthGuard)
  @Throttle({ limit: 10, windowMs: 30_000, keyPrefix: 'challenge-guess' })
  submitGuess(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { answer: string },
  ) {
    const solverId = req.user?.id || req.guest?.sessionId || undefined;
    return this.challenge.submitGuess(id, body.answer, solverId);
  }
}
