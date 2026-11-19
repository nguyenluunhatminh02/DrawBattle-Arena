import { Controller, Get, Post, Body, UseGuards, Req } from '@nestjs/common';
import { DailyService } from './daily.service';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';

@Controller('daily')
export class DailyController {
  constructor(private dailyService: DailyService) {}

  @Get('today')
  @UseGuards(OptionalAuthGuard)
  async getTodaysChallenge(@Req() req: any) {
    return this.dailyService.getTodaysChallenge(req.user?.id, req.guest?.sessionId);
  }

  @Post('submit')
  @UseGuards(OptionalAuthGuard)
  async submitAttempt(
    @Req() req: any,
    @Body() body: { challengeId: string; answer: string },
  ) {
    return this.dailyService.submitAttempt(
      body.challengeId,
      body.answer,
      req.user?.id,
      req.guest?.sessionId,
    );
  }

  @Post('generate')
  @UseGuards(AuthGuard)
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