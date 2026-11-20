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
        // A verified signature is not enough: deleted accounts must not keep
        // working, and the role/existence check must match AuthGuard.
        const user = await this.auth.validateUserToken(token);
        if (user) {
          request.user = { id: user.userId, type: user.type, nickname: user.nickname };
        }
      } else if (payload.type === 'guest') {
        const session = await this.auth.validateGuestToken(token);
        if (session) request.guest = session;
      }
    } catch {}
    return true;
  }
}
