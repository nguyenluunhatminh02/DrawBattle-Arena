import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
  ValidationOptions,
} from 'class-validator';
import { Type } from 'class-transformer';

export const GAME_MODES = ['CLASSIC', 'DUEL', 'SPEED', 'TEAM'] as const;
export const ROOM_DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD', 'MIXED'] as const;

/** Like @IsOptional, but explicit null is validated (and rejected) instead of skipped. */
function IsOptionalButNotNull(options?: ValidationOptions) {
  return ValidateIf((_object, value) => value !== undefined, options);
}

export class RoomSettingsDto {
  @IsOptionalButNotNull()
  @IsEnum(GAME_MODES)
  mode?: (typeof GAME_MODES)[number];

  @IsOptionalButNotNull()
  @IsInt()
  @Min(2)
  @Max(12)
  maxPlayers?: number;

  @IsOptionalButNotNull()
  @IsInt()
  @Min(1)
  @Max(10)
  rounds?: number;

  @IsOptionalButNotNull()
  @IsInt()
  @Min(15)
  @Max(300)
  turnDuration?: number;

  @IsOptionalButNotNull()
  @IsEnum(ROOM_DIFFICULTIES)
  difficulty?: (typeof ROOM_DIFFICULTIES)[number];

  @IsOptionalButNotNull()
  @IsBoolean()
  enableHints?: boolean;

  @IsOptionalButNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  password?: string;

  // Category/language/enableGuests are accepted but untrusted strings/flags;
  // keep them bounded without changing existing defaults.
  @IsOptionalButNotNull()
  @IsString()
  @MaxLength(64)
  category?: string;
}

/** Body accepted by POST /rooms. Unknown fields are stripped by the global pipe. */
export class CreateRoomDto {
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @ValidateNested()
  @Type(() => RoomSettingsDto)
  settings?: RoomSettingsDto;
}
