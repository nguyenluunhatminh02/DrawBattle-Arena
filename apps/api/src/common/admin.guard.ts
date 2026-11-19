import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = header.slice(7);
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new UnauthorizedException('JWT_SECRET not configured');
    let payload: { sub: string; exp?: number; type?: string; iat?: number };
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('malformed');
      const sig = parts[2];
      const crypto = await import('crypto');
      const data = parts[0] + '.' + parts[1];
      const expected = crypto
        .createHmac('sha256', secret)
        .update(data)
        .digest('base64url');
      if (expected !== sig) throw new Error('bad sig');
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch {
      throw new UnauthorizedException();
    }
    if (payload.type && payload.type !== 'user') {
      throw new ForbiddenException('Admin only');
    }
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Token expired');
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.role !== 'ADMIN') throw new ForbiddenException('Admin only');
    req.user = user;
    return true;
  }
}
