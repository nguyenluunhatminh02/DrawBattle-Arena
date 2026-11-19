import { Module } from '@nestjs/common';
import { GameStateService } from './game-state.service';
import { RoomModule } from '../room/room.module';
import { WordModule } from '../word/word.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { FeatureFlagModule } from '../feature-flag/feature-flag.module';

@Module({
  imports: [RoomModule, WordModule, PrismaModule, FeatureFlagModule],
  providers: [GameStateService],
  exports: [GameStateService],
})
export class GameModule {}
