import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface FunnelEvent {
  event: string;
  sessionId: string;
  data: Record<string, unknown>;
  ts: number;
}

/** Shape expected by the optional funnel_events table. */
export interface FunnelEventRow {
  event: string;
  sessionId: string;
  data: Record<string, unknown>;
  createdAt: Date;
}

export const TRACKED_EVENTS = [
  'landing_view',
  'guest_created',
  'room_created',
  'room_joined',
  'match_started',
  'turn_completed',
  'challenge_created',
  'challenge_opened',
  'challenge_guessed',
  'share_clicked',
] as const;

const MAX_EVENTS = 10_000;
const FLUSH_BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 5_000;

/** Rate-limit one log line per process per hour for an unavailable sink. */
const unavailableWarnings = new Set<string>();
export function logFunnelUnavailable(logger: Logger, message: string) {
  const key = message;
  if (unavailableWarnings.has(key)) return;
  unavailableWarnings.add(key);
  logger.warn(message);
}

/**
 * Durable funnel sink. Writes a single table when available; otherwise keeps a
 * bounded in-memory buffer so this API still works before the migration runs.
 */
@Injectable()
export class FunnelService implements OnModuleDestroy {
  private readonly logger = new Logger(FunnelService.name);
  private readonly events: FunnelEvent[] = [];
  private readonly pending: FunnelEvent[] = [];
  private readonly durable: boolean;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(private readonly prisma?: PrismaService) {
    this.durable = !!prisma?.hasOptionalTable?.('funnelEvent');
    if (this.durable) {
      this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref?.();
    } else {
      logFunnelUnavailable(
        this.logger,
        'funnel_events table unavailable; analytics are kept in memory only and lost on restart',
      );
    }
  }

  get isDurable() {
    return this.durable;
  }

  async onModuleDestroy() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }

  async track(event: string, sessionId?: string, data?: Record<string, unknown>) {
    if (!(TRACKED_EVENTS as readonly string[]).includes(event)) {
      return { ok: false, reason: 'unknown_event' };
    }

    const cleanData = sanitizeData(data);
    const item: FunnelEvent = {
      event,
      sessionId: (sessionId ?? 'anon').slice(0, 128),
      data: cleanData,
      ts: Date.now(),
    };

    if (this.events.length >= MAX_EVENTS) {
      this.events.splice(0, Math.floor(MAX_EVENTS / 2));
    }
    this.events.push(item);

    if (!this.durable) return { ok: true, durable: false };

    this.pending.push(item);
    if (this.pending.length >= FLUSH_BATCH_SIZE) await this.flush();
    return { ok: true, durable: true };
  }

  /** Flush queued events. Bounded so a slow DB never stalls a request queue. */
  async flush() {
    if (!this.durable || !this.prisma || this.flushing) return this.flushing ?? undefined;
    if (this.pending.length === 0) return;

    const batch = this.pending.splice(0, FLUSH_BATCH_SIZE);
    this.flushing = (async () => {
      try {
        await this.prisma!.funnelEvent.createMany({
          data: batch.map(item => ({
            event: item.event,
            sessionId: item.sessionId,
            data: item.data,
            createdAt: new Date(item.ts),
          })),
        });
      } catch (err) {
        logFunnelUnavailable(
          this.logger,
          `funnel event flush failed; dropping ${batch.length} events (${err instanceof Error ? err.message : String(err)})`,
        );
        // Do not retry a permanently failed batch forever (e.g. missing table).
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  async summary() {
    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;

    const counts: Record<string, number> = {};
    for (const event of TRACKED_EVENTS) counts[event] = 0;

    if (!this.durable || !this.prisma) {
      return this.summarize(counts, this.events.map(e => ({ ...e, ts: e.ts })), last24h);
    }

    try {
      const rows = await this.prisma.funnelEvent.findMany({
        where: { createdAt: { gte: new Date(last24h) } },
        select: { event: true, sessionId: true },
        orderBy: { createdAt: 'desc' },
        take: 100_000,
      });
      return this.summarize(
        counts,
        rows.map(row => ({ event: row.event, sessionId: row.sessionId, ts: 0 })),
        last24h,
      );
    } catch (err) {
      logFunnelUnavailable(
        this.logger,
        `funnel summary fell back to memory (${err instanceof Error ? err.message : String(err)})`,
      );
      return this.summarize(counts, this.events, last24h);
    }
  }

  private summarize(
    template: Record<string, number>,
    items: Array<{ event: string; sessionId: string; ts: number }>,
    last24h: number,
  ) {
    const counts = { ...template };
    let totalEvents = 0;
    const sessions = new Set<string>();
    for (const item of items) {
      if (item.ts && item.ts < last24h) continue;
      counts[item.event] = (counts[item.event] ?? 0) + 1;
      sessions.add(item.sessionId);
      totalEvents++;
    }
    return {
      period: '24h',
      totalEvents,
      uniqueSessions: sessions.size,
      counts,
      durable: this.durable,
    };
  }
}

/** Never let a client-supplied object smuggle in prototypes or unbounded data. */
function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data).slice(0, 20)) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = typeof value === 'string' ? value.slice(0, 200) : value;
    }
  }
  return result;
}
