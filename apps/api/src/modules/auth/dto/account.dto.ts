import { IsEmail, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

/** Body accepted by POST /account/register. */
export class RegisterDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password!: string;

  @IsString()
  @Length(1, 20)
  @Matches(/^[\p{L}\p{N} _-]+$/u, {
    message: 'nickname may only contain letters, numbers, spaces, underscores and hyphens',
  })
  nickname!: string;
}

/** Body accepted by POST /account/login. */
export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password!: string;
}
