import { IsString, MaxLength, MinLength } from 'class-validator';

export class SubmitDailyAttemptDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  answer!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  challengeId!: string;
}
