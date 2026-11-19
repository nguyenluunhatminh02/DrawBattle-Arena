import { Module } from '@nestjs/common';
import { ReplayService } from './replay.service';
import { ReplayController } from './replay.controller';
import { ReplayWorker } from './replay.worker';

@Module({
  controllers: [ReplayController],
  providers: [ReplayService, ReplayWorker],
  exports: [ReplayService],
})
export class ReplayModule {}
