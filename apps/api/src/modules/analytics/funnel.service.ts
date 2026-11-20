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
  private durable = false;
  private checkingDurable: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(private readonly prisma?: PrismaService) {
    if (prisma?.hasOptionalTable?.('funnelEvent')) {
      // A generated delegate does not prove the migration has run. Probe the
      // table once; if it does not exist, stay in memory-only mode.
      this.checkingDurable = this.checkDurability();
    } else {
      this.warnUnavailable();
    }
  }

  private async checkDurability() {
    try {
      await this.prisma!.funnelEvent.findFirst({
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      });
      this.durable = true;
      this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref?.();
    } catch (err) {
      this.warnUnavailable(err);
    }
  }

  private warnUnavailable(err?: unknown) {
    const suffix = err ? ` (${err instanceof Error ? err.message : String(err)})` : '';
    logFunnelUnavailable(
      this.logger,
      `funnel_events table unavailable; analytics are kept in memory only and lost on restart${suffix}`,
    );
  }

  get isDurable() {
    return this.durable;
  }

  async onModuleDestroy() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    // Wait for the capability probe so events queued during startup are not
    // discarded, then flush every pending batch and any in-flight flush.
    await this.checkingDurable;
    while (this.pending.length > 0 || this.flushing) {
      await this.flush();
    }
  }

  async track(event: string, sessionId?: string, data?: Record<string, unknown>) {
    if (!(TRACKED_EVENTS as readonly string[]).includes(event)) {
      return { ok: false, reason: 'unknown_event' };
    }

    const cleanData = sanitizeData(data);
    const item: FunnelEvent = {
      event,
      // JSON bodies can carry numbers, objects or arrays in this field. Never
      // call a string method on an untrusted value.
      sessionId: typeof sessionId === 'string' ? sessionId.slice(0, 128) : 'anon',
      data: cleanData,
      ts: Date.now(),
    };

    if (this.events.length >= MAX_EVENTS) {
      this.events.splice(0, Math.floor(MAX_EVENTS / 2));
    }
    this.events.push(item);

    if (!this.durable || !this.prisma) {
      return { ok: true, durable: false };
    }

    this.pending.push(item);
    if (this.pending.length >= FLUSH_BATCH_SIZE) await this.flush();
    return { ok: true, durable: true };
  }

  /** Flush one queued batch. Bounded so a slow DB never stalls a request queue. */
  async flush() {
    if (!this.durable || !this.prisma) return;
    // A concurrent caller must await the active write instead of splicing a
    // second batch into an already drained queue.
    if (this.flushing) {
      await this.flushing;
      return;
    }
    if (this.pending.length === 0) return;

    const batch = this.pending.splice(0, FLUSH_BATCH_SIZE);
    const write = (async () => {
      try {
        await this.prisma!.funnelEvent.createMany({
          data: batch.map(item => ({
            event: item.event,
            sessionId: item.sessionId,
            data: item.data as never,
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
    this.flushing = write;
    try {
      await write;
    } finally {
      if (this.flushing === write) this.flushing = null;
    }
  }

  async summary() {
    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;

    const counts: Record<string, number> = {};
    for (const event of TRACKED_EVENTS) counts[event] = 0;

    // Pending events have not reached the table yet, and an in-flight flush
    // may still be writing its batch. A pending event is the same object as its
    // in-memory copy, so deduplicate by identity before counting.
    const bufferedItems = new Set<FunnelEvent>(this.events);
    for (const item of this.pending) bufferedItems.add(item);
    const buffered = [...bufferedItems].map(e => ({ ...e, ts: e.ts }));

    if (!this.durable || !this.prisma) {
      return this.summarize(counts, buffered, last24h);
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
        [
          ...rows.map(row => ({ event: row.event, sessionId: row.sessionId, ts: 0 })),
          ...buffered,
        ],
        last24h,
      );
    } catch (err) {
      logFunnelUnavailable(
        this.logger,
        `funnel summary fell back to memory (${err instanceof Error ? err.message : String(err)})`,
      );
      return this.summarize(counts, buffered, last24h);
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
