import { Controller, Get, Post, Body, UseGuards, Req } from '@nestjs/common';
import { DailyService } from './daily.service';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AdminGuard } from '../../common/admin.guard';
import { Throttle } from '../../common/throttle.guard';
import { SubmitDailyAttemptDto } from './daily.dto';

@Controller('daily')
export class DailyController {
  constructor(private dailyService: DailyService) {}

  @Get('today')
  @UseGuards(OptionalAuthGuard)
  async getTodaysChallenge(@Req() req: any) {
    // DAILY-03: an account JWT always identifies the player; a guest token is
    // only used when no account token is present.
    const userId = req.user?.id;
    const guestSessionId = userId ? undefined : req.guest?.sessionId;
    return this.dailyService.getTodaysChallenge(userId, guestSessionId);
  }

  @Post('submit')
  @UseGuards(OptionalAuthGuard)
  @Throttle({ limit: 20, windowMs: 60_000, keyPrefix: 'daily-submit' })
  async submitAttempt(
    @Req() req: any,
    @Body() body: SubmitDailyAttemptDto,
  ) {
    const userId = req.user?.id;
    const guestSessionId = userId ? undefined : req.guest?.sessionId;
    return this.dailyService.submitAttempt(
      body.challengeId,
      body.answer,
      userId,
      guestSessionId,
    );
  }

  @Post('generate')
  @UseGuards(AdminGuard)
  async generateDailyChallenge() {
    await this.dailyService.generateDailyChallenge();
    return { success: true };
  }

  @Get('streak')
  @UseGuards(AuthGuard)
  async getStreak(@Req() req: any) {
    return this.dailyService.getStreak(req.user.id);
  }
}
