import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ChallengeService } from './challenge.service';
import { Throttle } from '../../common/throttle.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import type { WordDifficulty } from '@drawbattle/shared';
import type { Identity } from './challenge.service';
import { FinalizeChallengeDto, SubmitChallengeGuessDto } from './challenge.dto';

@Controller('challenges')
export class ChallengeController {
  constructor(private readonly challenge: ChallengeService) {}

  @Post()
  @UseGuards(OptionalAuthGuard)
  @Throttle({ limit: 10, windowMs: 60_000, keyPrefix: 'challenge-create' })
  create(@Body() body: { difficulty?: WordDifficulty; category?: string; wordId?: string }, @Req() req: any) {
    const userId = req.user?.id;
    const creator: Identity = {
      userId,
      sessionId: userId ? undefined : req.guest?.sessionId,
    };
    return this.challenge.create(body, creator);
  }

  @Post(':id/finalize')
  @UseGuards(OptionalAuthGuard)
  finalize(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: FinalizeChallengeDto,
  ) {
    const userId = req.user?.id;
    const actor: Identity = {
      userId,
      sessionId: userId ? undefined : req.guest?.sessionId,
    };
    return this.challenge.finalize(id, body.strokes, body.durationMs, actor);
  }

  @Get(':id')
  @UseGuards(OptionalAuthGuard)
  info(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id;
    const solver: Identity = {
      userId,
      sessionId: userId ? undefined : req.guest?.sessionId,
    };
    return this.challenge.getInfo(id, solver);
  }

  @Post(':id/guesses')
  @UseGuards(OptionalAuthGuard)
  @Throttle({ limit: 10, windowMs: 30_000, keyPrefix: 'challenge-guess' })
  submitGuess(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: SubmitChallengeGuessDto,
  ) {
    const userId = req.user?.id;
    const solver: Identity = {
      userId,
      sessionId: userId ? undefined : req.guest?.sessionId,
    };
    return this.challenge.submitGuess(id, body.answer, solver);
  }
}
