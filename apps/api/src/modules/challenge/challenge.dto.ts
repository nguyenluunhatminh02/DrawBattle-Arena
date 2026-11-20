import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { GAME_CONSTANTS } from '@drawbattle/shared';

export interface ChallengeStroke {
  strokeId: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
}

export class StrokePointDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  x!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  y!: number;
}

export class StrokeDto implements ChallengeStroke {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  strokeId!: string;

  @IsArray()
  @ArrayMaxSize(GAME_CONSTANTS.MAX_POINTS_PER_STROKE)
  @ValidateNested({ each: true })
  @Type(() => StrokePointDto)
  points!: StrokePointDto[];

  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  color!: string;

  @IsInt()
  @Min(1)
  @Max(64)
  width!: number;
}

export class FinalizeChallengeDto {
  @IsArray()
  @ArrayMaxSize(GAME_CONSTANTS.MAX_STROKES_PER_TURN)
  @ValidateNested({ each: true })
  @Type(() => StrokeDto)
  strokes!: StrokeDto[];

  @IsInt()
  @Min(1000)
  @Max(GAME_CONSTANTS.CHALLENGE_DRAW_TIME * 1000)
  durationMs!: number;
}

export class SubmitChallengeGuessDto {
  @IsString()
  @MaxLength(200)
  answer!: string;
}
