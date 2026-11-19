import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottleGuard } from './throttle.guard';
import { CleanupService } from './cleanup.service';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    CleanupService,
    { provide: APP_GUARD, useClass: ThrottleGuard },
  ],
  exports: [CleanupService],
})
export class CommonModule {}
