import { Module } from '@nestjs/common';
import { ReplayService } from './replay.service';
import { ReplayController } from './replay.controller';
import { ReplayWorker } from './replay.worker';
import { ReplayJobService } from './replay-jobs';

@Module({
  controllers: [ReplayController],
  providers: [ReplayService, ReplayWorker, ReplayJobService],
  exports: [ReplayService, ReplayJobService, ReplayWorker],
})
export class ReplayModule {}
