import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtService } from './jwt.service';
import { AuthGuard } from './auth.guard';
import { OptionalAuthGuard } from './optional-auth.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, JwtService, AuthGuard, OptionalAuthGuard],
  exports: [AuthService, JwtService, AuthGuard, OptionalAuthGuard],
})
export class AuthModule {}
