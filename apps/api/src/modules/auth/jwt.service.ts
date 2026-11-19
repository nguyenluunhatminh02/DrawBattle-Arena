import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';

interface TokenPayload {
  sub: string;
  type: string;
  nickname?: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtService {
  private readonly secret: string;
  private readonly expiresIn: number;

  constructor(private readonly config: ConfigService) {
    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET environment variable is required but not configured');
    }
    this.secret = secret;
    this.expiresIn = 7 * 24 * 60 * 60;
  }

  sign(payload: Omit<TokenPayload, 'iat' | 'exp'>): string {
    return jwt.sign(payload, this.secret, { expiresIn: this.expiresIn });
  }

  verify(token: string): TokenPayload {
    return jwt.verify(token, this.secret, { algorithms: ['HS256'] }) as TokenPayload;
  }
}
