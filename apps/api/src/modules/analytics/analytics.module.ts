import { Module } from '@nestjs/common';
import { FunnelController } from './funnel.controller';
import { FunnelService } from './funnel.service';
import { AdminGuard } from '../../common/admin.guard';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [FunnelController],
  providers: [FunnelService, AdminGuard],
})
export class AnalyticsModule {}
