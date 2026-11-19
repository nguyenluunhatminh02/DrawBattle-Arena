import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from './jwt.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('No token provided');
    }

    const token = authHeader.substring(7);
    try {
      const payload = this.jwtService.verify(token);
      if (payload.type !== 'user') {
        throw new UnauthorizedException('Invalid token type');
      }
      request.user = { id: payload.sub, type: payload.type, nickname: payload.nickname };
      return true;
    } catch (error) {
      throw new UnauthorizedException('Invalid token');
    }
  }
}