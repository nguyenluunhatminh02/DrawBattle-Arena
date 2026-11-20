import { Module } from '@nestjs/common';
import { DailyController } from './daily.controller';
import { DailyService } from './daily.service';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../../common/admin.guard';

@Module({
  imports: [AuthModule],
  controllers: [DailyController],
  providers: [DailyService, AdminGuard],
  exports: [DailyService],
})
export class DailyModule {}