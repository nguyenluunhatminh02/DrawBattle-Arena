import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createClient, type RedisClientType } from 'redis';
import { recordMetric } from './metrics-counters';

export interface ThrottleConfig {
  limit: number;
  windowMs: number;
  keyPrefix?: string;
}

// Cap the number of tracked buckets so an attacker rotating source IPs or
// guest session IDs cannot grow this Map without bound. Stale buckets are
// reclaimed even when the map is not full.
const MAX_BUCKETS = 10_000;
const REDIS_KEY_PREFIX = 'drawbattle:throttle:';
/** Silent fallback when Redis is unavailable must not swallow all abuse. */
const REDIS_FAILURE_LOG_INTERVAL_MS = 60_000;
/**
 * After a Redis command fails, keep using local buckets only for this long.
 * A permanent latch would leave every later request on the weaker per-process
 * fallback even after Redis recovers.
 */
const REDIS_RETRY_MS = 30_000;

/**
 * Atomic fixed-window counter. Returns [count, ttlMs]; INCR and EXPIRE are
 * applied in one round trip so concurrent API instances share one bucket and
 * a failed EXPIRE can never leave a key without a TTL.
 */
const THROTTLE_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = ARGV[1]
end
return { current, ttl }
`;

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

type Bucket = { count: number; resetAt: number };

/**
 * Global HTTP throttle. Uses a shared Redis fixed-window bucket when REDIS_URL
 * is configured and the client is connected; otherwise it falls back to the
 * original process-local buckets. After a Redis error it retries on a cooldown
 * (or as soon as Redis reports ready again), and logs at most once a minute.
 * Redis failures never fail a request.
 */
@Injectable()
export class ThrottleGuard implements CanActivate, OnModuleDestroy {
  private readonly logger = new Logger(ThrottleGuard.name);
  private readonly buckets = new Map<string, Bucket>();
  private readonly redis: RedisClientType | null;
  private redisRetryAfter = 0;
  private lastRedisFailureAt = 0;

  constructor(private readonly reflector: Reflector) {
    this.redis = this.createRedisClient();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    // parseInt yields NaN for malformed values; `|| 1` hides that but also
    // silently accepts negatives/fractionals. Clamp to a finite positive
    // integer so a bad env var can never disable or inflate the rate limit.
    const parsedMult = Number.parseInt(process.env.THROTTLE_MULT ?? '1', 10);
    const mult = Number.isFinite(parsedMult) && parsedMult > 0 ? Math.floor(parsedMult) : 1;
    const limit = config.limit * mult;

    const allowed = this.redis && Date.now() >= this.redisRetryAfter
      ? await this.checkRedis(key, config.windowMs, limit)
      : this.checkLocal(key, config.windowMs, limit);
    if (!allowed) {
      recordMetric('throttle_rejects_total');
      recordMetric(`throttle_rejects_${config.keyPrefix ?? 'global'}`);
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  async onModuleDestroy() {
    if (this.redis?.isOpen) await this.redis.quit().catch(() => undefined);
  }

  private createRedisClient(): RedisClientType | null {
    const url = process.env.REDIS_URL;
    if (!url) return null;
    try {
      const client = createClient({ url }) as RedisClientType;
      client.on('error', err => this.onRedisError(err));
      // A reconnection can complete before the cooldown expires; resume shared
      // buckets immediately instead of waiting out the rest of the interval.
      client.on('ready', () => {
        this.redisRetryAfter = 0;
      });
      // Connection failures are reported by the 'error' handler; catch here so
      // boot never fails just because rate limiting must use the fallback.
      void client.connect().catch(err => this.onRedisError(err));
      return client;
    } catch (err) {
      this.onRedisError(err);
      return null;
    }
  }

  private onRedisError(err: unknown): void {
    // A dead Redis must not take down the HTTP API, but silence would hide the
    // fact that throttling degraded to per-process buckets.
    if (Date.now() - this.lastRedisFailureAt < REDIS_FAILURE_LOG_INTERVAL_MS) return;
    this.lastRedisFailureAt = Date.now();
    this.logger.warn(
      `Redis throttle unavailable; using in-memory buckets (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  private async checkRedis(key: string, windowMs: number, limit: number): Promise<boolean> {
    const client = this.redis;
    if (!client?.isReady) return this.checkLocal(key, windowMs, limit);
    try {
      const result = (await client.eval(THROTTLE_SCRIPT, {
        keys: [`${REDIS_KEY_PREFIX}${key}`],
        arguments: [String(windowMs)],
      })) as [number, number];
      this.redisRetryAfter = 0;
      return Number(result[0]) <= limit;
    } catch (err) {
      this.onRedisError(err);
      // Pause Redis briefly: repeated awaited failures on every request would
      // add latency and log noise while Redis is down, but a permanent latch
      // would never notice recovery. The cooldown is also cleared by 'ready'.
      this.redisRetryAfter = Date.now() + REDIS_RETRY_MS;
      return this.checkLocal(key, windowMs, limit);
    }
  }

  private checkLocal(key: string, windowMs: number, limit: number): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      // Reclaim expired buckets lazily, and evict the oldest entries if the
      // map hits its cap. Without this, rotating IPs or guest IDs leak memory.
      this.pruneExpired(now);
      if (this.buckets.size >= MAX_BUCKETS) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    return bucket.count <= limit;
  }

  private pruneExpired(now: number): void {
    // Skip the sweep unless there is meaningful pressure, so the common path
    // stays O(1). A cap-triggered sweep still reclaims every expired bucket.
    if (this.buckets.size < MAX_BUCKETS / 2) return;
    for (const [key, value] of this.buckets) {
      if (now >= value.resetAt) this.buckets.delete(key);
    }
  }
}
