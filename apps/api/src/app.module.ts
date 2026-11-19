import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './modules/auth/auth.module';
import { WordModule } from './modules/word/word.module';
import { RoomModule } from './modules/room/room.module';
import { GameModule } from './modules/game/game.module';
import { ChallengeModule } from './modules/challenge/challenge.module';
import { SocketModule } from './modules/socket/socket.module';
import { MatchModule } from './modules/match/match.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { ReportModule } from './modules/report/report.module';
import { LeaderboardModule } from './modules/leaderboard/leaderboard.module';
import { AccountModule } from './modules/account/account.module';
import { DailyModule } from './modules/daily/daily.module';
import { FeatureFlagModule } from './modules/feature-flag/feature-flag.module';
import { ModerationModule } from './modules/moderation/moderation.module';
import { ReplayModule } from './modules/replay/replay.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    CommonModule,
    AuthModule,
    WordModule,
    RoomModule,
    GameModule,
    ChallengeModule,
    SocketModule,
    MatchModule,
    AnalyticsModule,
    ReportModule,
    LeaderboardModule,
    AccountModule,
    DailyModule,
    FeatureFlagModule,
    ModerationModule,
    ReplayModule,
  ],
})
export class AppModule {}
