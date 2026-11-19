import { Injectable, BadRequestException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from '../auth/jwt.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AccountService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async register(email: string, password: string, nickname: string) {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new BadRequestException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        nickname,
      },
    });

    const token = this.jwtService.sign({ sub: user.id, type: 'user', nickname: user.nickname });
    return { token, user: { id: user.id, email: user.email, nickname: user.nickname } };
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const token = this.jwtService.sign({ sub: user.id, type: 'user', nickname: user.nickname });
    return { token, user: { id: user.id, email: user.email, nickname: user.nickname } };
  }

  async linkGuestToUser(guestSessionId: string, userId: string, guestToken: string) {
    const guest = await this.prisma.guestSession.findUnique({ where: { id: guestSessionId } });
    if (!guest) {
      throw new BadRequestException('Guest session not found');
    }

    if (guest.userId && guest.userId !== userId) {
      throw new BadRequestException('Guest session already linked to another account');
    }

    let tokenPayload: { sub: string };
    try {
      tokenPayload = this.jwtService.verify(guestToken);
    } catch {
      throw new UnauthorizedException('Invalid guest token');
    }
    if (tokenPayload.sub !== guestSessionId) {
      throw new ForbiddenException('Token does not match guest session');
    }

    await this.prisma.guestSession.update({
      where: { id: guestSessionId },
      data: { userId },
    });

    try {
      await this.prisma.roomPlayer.updateMany({
        where: { guestSessionId, userId: null },
        data: { userId },
      });
    } catch {}

    return { success: true };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        nickname: true,
        avatar: true,
        createdAt: true,
        streaks: {
          select: {
            currentStreak: true,
            longestStreak: true,
            lastPlayedAt: true,
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const matchCount = await this.prisma.score.count({
      where: { player: { userId } },
    });

    const totalScore = await this.prisma.score.aggregate({
      where: { player: { userId } },
      _sum: { points: true },
    });

    return {
      ...user,
      streak: user.streaks[0] || { currentStreak: 0, longestStreak: 0, lastPlayedAt: null },
      stats: {
        matchesPlayed: matchCount,
        totalScore: totalScore._sum.points || 0,
      },
    };
  }
}