import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from './jwt.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async createGuestSession(nickname: string) {
    const trimmed = (nickname ?? '').trim();
    if (!/^[\p{L}\p{N} _-]{1,20}$/u.test(trimmed)) {
      throw new BadRequestException(
        'Invalid nickname: 1-20 characters, letters/numbers/spaces/_/- only',
      );
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const session = await this.prisma.guestSession.create({
      data: { tokenHash, expiresAt },
    });

    const token = this.jwt.sign({
      sub: session.id,
      type: 'guest',
      nickname: trimmed,
    });

    return {
      token,
      playerId: session.id,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async validateGuestToken(token: string) {
    try {
      const payload = this.jwt.verify(token);
      if (payload.type !== 'guest') {
        this.logger.warn('Rejected non-guest token on guest validation');
        return null;
      }

      const session = await this.prisma.guestSession.findUnique({
        where: { id: payload.sub },
      });

      if (!session || session.expiresAt < new Date()) {
        this.logger.warn('Guest token session missing or expired');
        return null;
      }

      await this.prisma.guestSession.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date() },
      });

      return {
        sessionId: session.id,
        nickname: payload.nickname as string,
      };
    } catch (err) {
      // Log only the failure reason: the token itself is a secret.
      this.logger.warn(
        `Guest token validation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async validateUserToken(token: string) {
    try {
      const payload = this.jwt.verify(token);
      if (payload.type !== 'user') {
        this.logger.warn('Rejected non-user token on user validation');
        return null;
      }

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, nickname: true, role: true },
      });
      if (!user) {
        this.logger.warn('User token references a missing user');
        return null;
      }

      return {
        userId: user.id,
        nickname: user.nickname,
        role: user.role,
        type: payload.type,
      };
    } catch (err) {
      // Log only the failure reason: the token itself is a secret.
      this.logger.warn(
        `User token validation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
