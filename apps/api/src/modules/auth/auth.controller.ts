import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { AuthService } from './auth.service';
import { Throttle } from '../../common/throttle.guard';
import { containsProfanity } from '../../common/profanity';
import { BadRequestException } from '@nestjs/common';

export class CreateGuestDto {
  @IsString()
  @Length(1, 20)
  nickname!: string;
}

@Controller('guest-sessions')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post()
  @Throttle({ limit: 10, windowMs: 60_000, keyPrefix: 'guest' })
  createGuest(@Body() dto: CreateGuestDto) {
    if (containsProfanity(dto.nickname)) {
      throw new BadRequestException('Nickname contains inappropriate language');
    }
    return this.auth.createGuestSession(dto.nickname);
  }
}
