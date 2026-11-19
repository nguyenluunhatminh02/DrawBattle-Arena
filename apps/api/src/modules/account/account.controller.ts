import { Controller, Post, Get, Delete, Body, UseGuards, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AccountService } from './account.service';
import { AvatarService } from './avatar.service';
import { AuthGuard } from '../auth/auth.guard';
import { Throttle } from '../../common/throttle.guard';

@Controller('account')
export class AccountController {
  constructor(
    private accountService: AccountService,
    private avatarService: AvatarService,
  ) {}

  @Post('register')
  @Throttle({ limit: 5, windowMs: 60_000, keyPrefix: 'account-register' })
  async register(@Body() body: { email: string; password: string; nickname: string }) {
    return this.accountService.register(body.email, body.password, body.nickname);
  }

  @Post('login')
  @Throttle({ limit: 10, windowMs: 60_000, keyPrefix: 'account-login' })
  async login(@Body() body: { email: string; password: string }) {
    return this.accountService.login(body.email, body.password);
  }

  @Post('link-guest')
  @UseGuards(AuthGuard)
  async linkGuest(@Req() req: any, @Body() body: { guestSessionId: string }) {
    return this.accountService.linkGuestToUser(body.guestSessionId, req.user.id);
  }

  @Get('profile')
  @UseGuards(AuthGuard)
  async getProfile(@Req() req: any) {
    return this.accountService.getProfile(req.user.id);
  }

  @Post('avatar')
  @UseGuards(AuthGuard)
  @UseInterceptors(FileInterceptor('avatar'))
  async uploadAvatar(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    const avatarUrl = await this.avatarService.uploadAvatar(req.user.id, file);
    return { avatarUrl };
  }

  @Delete('avatar')
  @UseGuards(AuthGuard)
  async deleteAvatar(@Req() req: any) {
    await this.avatarService.deleteAvatar(req.user.id);
    return { success: true };
  }
}