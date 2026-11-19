import { Injectable, Logger } from '@nestjs/common';

interface FunnelEvent {
  event: string;
  sessionId: string;
  data: Record<string, unknown>;
  ts: number;
}

const TRACKED_EVENTS = [
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

@Injectable()
export class FunnelService {
  private readonly logger = new Logger(FunnelService.name);
  private readonly events: FunnelEvent[] = [];
  private readonly MAX_EVENTS = 10000;

  track(event: string, sessionId?: string, data?: Record<string, unknown>) {
    if (!(TRACKED_EVENTS as readonly string[]).includes(event)) {
      return { ok: false, reason: 'unknown_event' };
    }
    if (this.events.length >= this.MAX_EVENTS) {
      this.events.splice(0, Math.floor(this.MAX_EVENTS / 2));
    }
    this.events.push({
      event,
      sessionId: sessionId ?? 'anon',
      data: data ?? {},
      ts: Date.now(),
    });
    return { ok: true };
  }

  summary() {
    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;
    const recent = this.events.filter(e => e.ts >= last24h);

    const counts: Record<string, number> = {};
    for (const e of TRACKED_EVENTS) counts[e] = 0;
    for (const e of recent) counts[e.event]++;

    const uniqueSessions = new Set(recent.map(e => e.sessionId)).size;

    return {
      period: '24h',
      totalEvents: recent.length,
      uniqueSessions,
      counts,
    };
  }
}
