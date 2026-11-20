import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export interface ThrottleConfig {
  limit: number;
  windowMs: number;
  keyPrefix?: string;
}

export const THROTTLE_KEY = 'throttle_config';

export function Throttle(config: ThrottleConfig) {
  return (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (descriptor) {
      Reflect.defineMetadata(THROTTLE_KEY, config, descriptor.value);
    } else {
      Reflect.defineMetadata(THROTTLE_KEY, config, target);
    }
    return descriptor ?? target;
  };
}

@Injectable()
export class ThrottleGuard implements CanActivate {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const config =
      this.reflector.get<ThrottleConfig>(THROTTLE_KEY, context.getHandler()) ??
      this.reflector.get<ThrottleConfig>(THROTTLE_KEY, context.getClass());
    if (!config) return true;

    const request = context.switchToHttp().getRequest();
    // Never key on a raw client-supplied header (CF-Connecting-IP /
    // X-Forwarded-For): it is spoofable unless the trusted edge overwrites it.
    // Express resolves req.ip from trusted proxy hops via `trust proxy`.
    const identity =
      (request.user as { id?: string } | undefined)?.id ??
      (request.guest as { sessionId?: string } | undefined)?.sessionId;
    const ip = identity
      ? `identity:${identity}`
      : request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    const key = `${config.keyPrefix ?? 'global'}:${ip}`;
    const now = Date.now();

    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + config.windowMs };
      this.buckets.set(key, bucket);
    }

    // parseInt yields NaN for malformed values; `|| 1` hides that but also
    // silently accepts negatives/fractionals. Clamp to a finite positive
    // integer so a bad env var can never disable or inflate the rate limit.
    const parsedMult = Number.parseInt(process.env.THROTTLE_MULT ?? '1', 10);
    const mult = Number.isFinite(parsedMult) && parsedMult > 0 ? Math.floor(parsedMult) : 1;
    bucket.count++;
    if (bucket.count > config.limit * mult) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
