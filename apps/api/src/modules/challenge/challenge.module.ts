import { Module } from '@nestjs/common';
import { ChallengeController } from './challenge.controller';
import { ChallengeService } from './challenge.service';
import { AuthModule } from '../auth/auth.module';
import { WordModule } from '../word/word.module';

@Module({
  imports: [AuthModule, WordModule],
  controllers: [ChallengeController],
  providers: [ChallengeService],
  exports: [ChallengeService],
})
export class ChallengeModule {}
