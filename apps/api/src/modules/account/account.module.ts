import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AvatarService } from './avatar.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [AccountController],
  providers: [AccountService, AvatarService],
  exports: [AccountService],
})
export class AccountModule {}