import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from './jwt.service';
import { AuthService } from './auth.service';

@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return true;

    const token = authHeader.substring(7);
    try {
      const payload = this.jwtService.verify(token);
      if (payload.type === 'user') {
        request.user = { id: payload.sub, type: payload.type, nickname: payload.nickname };
      } else if (payload.type === 'guest') {
        const session = await this.auth.validateGuestToken(token);
        if (session) request.guest = session;
      }
    } catch {}
    return true;
  }
}