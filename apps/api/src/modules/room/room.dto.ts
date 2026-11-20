import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const GAME_MODES = ['CLASSIC', 'DUEL', 'SPEED', 'TEAM'] as const;
export const ROOM_DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD', 'MIXED'] as const;

export class RoomSettingsDto {
  @IsOptional()
  @IsEnum(GAME_MODES)
  mode?: (typeof GAME_MODES)[number];

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(12)
  maxPlayers?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  rounds?: number;

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(300)
  turnDuration?: number;

  @IsOptional()
  @IsEnum(ROOM_DIFFICULTIES)
  difficulty?: (typeof ROOM_DIFFICULTIES)[number];

  @IsOptional()
  @IsBoolean()
  enableHints?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  password?: string;

  // Category/language/enableGuests are accepted but untrusted strings/flags;
  // keep them bounded without changing existing defaults.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;
}

/** Body accepted by POST /rooms. Unknown fields are stripped by the global pipe. */
export class CreateRoomDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => RoomSettingsDto)
  settings?: RoomSettingsDto;
}
