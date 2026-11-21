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
import jwt from 'jsonwebtoken';
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
 * After a Redis command fails, keep using local per-process buckets for this
 * long. Every failure extends the deadline; only the client's `ready` event or
 * expiry of the cooldown may resume shared buckets.
 */
const REDIS_RETRY_MS = 30_000;

/**
 * Atomic fixed-window counters for every required bucket. All KEYS are
 * incremented in one eval so IP and identity accounting cannot be split by a
 * concurrent request. The window from ARGV[1] is applied with PEXPIRE to each
 * key when its window starts (or its TTL is missing), and counts are returned
 * in the same order as KEYS.
 */
const THROTTLE_SCRIPT = `
local counts = {}
for i, key in ipairs(KEYS) do
  local current = redis.call('INCR', key)
  if current == 1 then
    redis.call('PEXPIRE', key, ARGV[1])
  end
  if redis.call('PTTL', key) < 0 then
    redis.call('PEXPIRE', key, ARGV[1])
  end
  counts[i] = current
end
return counts
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
 * Resolve a throttle identity from a verified *user* principal. Global guards
 * run before controller-level `OptionalAuthGuard`, so `request.user` may not
 * be populated when this guard executes. Verifying the bearer token here (with
 * the same JWT_SECRET and algorithm as JwtService) keeps identity buckets
 * working regardless of guard registration order; forged/invalid tokens fall
 * back to the trusted `req.ip` bucket only.
 *
 * Guest tokens are deliberately ignored: anyone can mint as many as they like
 * and rotating their `sub` must not split an IP's bucket. For the same reason
 * only an explicit `type === 'user'` principal or signed token is accepted, so
 * a caller cannot choose an arbitrary bucket key (a populated principal with
 * an unknown/missing type is never trusted). Database validity checks (deleted
 * users) remain in the auth guards; a stale user token can at worst exhaust
 * its own bucket.
 */
function userIdentity(request: {
  headers?: Record<string, unknown>;
  user?: { id?: string; type?: string };
}): string | null {
  const populated = request.user;
  if (
    populated?.type === 'user' &&
    typeof populated.id === 'string' &&
    populated.id
  ) {
    return `identity:user:${populated.id}`;
  }

  const header = request.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  if (!token) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as {
      sub?: unknown;
      type?: unknown;
    };
    if (payload.type === 'user' && typeof payload.sub === 'string' && payload.sub) {
      return `identity:user:${payload.sub}`;
    }
  } catch {
    // Invalid signature, expired or malformed token: fall back to IP.
  }
  return null;
}

/**
 * Global HTTP throttle. Every request consumes an IP bucket. Verified users
 * also consume a separate identity bucket, so rotating IPs cannot raise their
 * per-identity limit and rotating identities cannot raise an IP's limit. The
 * stricter bound wins: if either bucket is over, the request is rejected.
 * Uses one shared Redis eval for all buckets when REDIS_URL is configured and
 * the client is connected; otherwise it falls back to process-local buckets.
 * During a Redis outage, fallback limits are per-process: each API instance
 * gets its own allowance, so the effective fleet-wide limit is multiplied by
 * the instance count. That weakening is accepted and documented; retries are
 * gated by a cooldown extended on every failure (or resumed as soon as Redis
 * reports ready), and failures are logged at most once a minute.
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
    const ip = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    const prefix = config.keyPrefix ?? 'global';
    // IP is the mandatory floor for every caller. A verified identity adds an
    // independent bucket; guests/forged tokens must not create extra buckets.
    const keys = [`${prefix}:ip:${ip}`];
    const identity = userIdentity(request);
    if (identity) keys.push(`${prefix}:identity:${identity}`);

    // parseInt yields NaN for malformed values; `|| 1` hides that but also
    // silently accepts negatives/fractionals. Clamp to a finite positive
    // integer so a bad env var can never disable or inflate the rate limit.
    const parsedMult = Number.parseInt(process.env.THROTTLE_MULT ?? '1', 10);
    const mult = Number.isFinite(parsedMult) && parsedMult > 0 ? Math.floor(parsedMult) : 1;
    const limit = config.limit * mult;

    const useRedis = Boolean(this.redis && Date.now() >= this.redisRetryAfter);
    // One decision for all buckets: the eval increments every key atomically,
    // and the local fallback checks every key even if the first one rejects.
    // Otherwise a rejected request could leave one bucket under-counted and let
    // a later request slip through.
    const allowed = useRedis
      ? await this.checkRedis(keys, config.windowMs, limit)
      : this.checkLocal(keys, config.windowMs, limit);
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

  private async checkRedis(keys: string[], windowMs: number, limit: number): Promise<boolean> {
    const client = this.redis;
    if (!client?.isReady) return this.checkLocal(keys, windowMs, limit);
    try {
      const counts = (await client.eval(THROTTLE_SCRIPT, {
        keys: keys.map(key => `${REDIS_KEY_PREFIX}${key}`),
        arguments: [String(windowMs)],
      })) as unknown[];
      // A success must not clear a cooldown that is still active: a late reply
      // from a previously failed command would otherwise reopen Redis while it
      // is still flapping. 'ready' and expiry are the only other resume paths.
      if (Date.now() >= this.redisRetryAfter) this.redisRetryAfter = 0;
      // Every key is incremented atomically; reject if any bucket is over.
      return counts.every(count => Number(count) <= limit);
    } catch (err) {
      this.onRedisError(err);
      // Extend the cooldown on every failure: a lingering command error must
      // not clear an already-active deadline. Only 'ready' or expiry resumes
      // Redis; local fallback limits are per-process during an outage.
      this.redisRetryAfter = Date.now() + REDIS_RETRY_MS;
      return this.checkLocal(keys, windowMs, limit);
    }
  }

  private checkLocal(keys: string[], windowMs: number, limit: number): boolean {
    const now = Date.now();
    let allowed = true;
    // Check all buckets even after a rejection so each consumes one token.
    for (const key of keys) {
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
      if (bucket.count > limit) allowed = false;
    }
    return allowed;
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
