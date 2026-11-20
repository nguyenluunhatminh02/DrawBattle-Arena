import { Module } from '@nestjs/common';
import { FunnelController } from './funnel.controller';
import { FunnelService } from './funnel.service';
import { MetricsController } from './metrics.controller';
import { AdminGuard } from '../../common/admin.guard';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ReplayModule } from '../replay/replay.module';
import { SocketModule } from '../socket/socket.module';

@Module({
  imports: [AuthModule, PrismaModule, ReplayModule, SocketModule],
  controllers: [FunnelController, MetricsController],
  providers: [FunnelService, AdminGuard],
})
export class AnalyticsModule {}
