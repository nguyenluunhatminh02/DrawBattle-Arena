import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { RawRenderJob } from '../modules/replay/replay-jobs';
import type { FunnelEventRow } from '../modules/analytics/funnel.service';

/**
 * Typed access to the OPTIONAL tables described in the schema fragments under
 * src/prisma/. Those tables are not generated into PrismaClient until a
 * migration is applied, so the production client is extended at runtime.
 * Every call site still checks for availability before use.
 */
export interface OptionalTables {
  renderJob: {
    findUnique(args: { where: { id: string } | { replayId: string } }): Promise<RawRenderJob | null>;
    findFirst(args: { where: Record<string, unknown> }): Promise<RawRenderJob | null>;
    upsert(args: {
      where: { replayId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<RawRenderJob>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
  funnelEvent: {
    createMany(args: { data: FunnelEventRow[] }): Promise<{ count: number }>;
    findMany(args: {
      where: Record<string, unknown>;
      select: Record<string, true>;
      orderBy: Record<string, string>;
      take: number;
    }): Promise<Array<{ event: string; sessionId: string }>>;
  };
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy, OptionalTables {
  // Declared with `!` because the delegate only exists after an optional
  // migration is deployed. Availability checks use `in` before access.
  renderJob!: OptionalTables['renderJob'];
  funnelEvent!: OptionalTables['funnelEvent'];

  /**
   * Safe feature detection for the optional tables. A declared class field can
   * exist as `undefined`, so presence alone is not enough: require the actual
   * Prisma delegate methods before taking the durable path.
   */
  hasOptionalTable(name: 'renderJob' | 'funnelEvent'): boolean {
    const delegate = (this as unknown as Record<string, unknown>)[name] as
      | Record<string, unknown>
      | undefined;
    if (!delegate) return false;
    const requiredMethod = name === 'renderJob' ? 'findUnique' : 'createMany';
    return typeof delegate[requiredMethod] === 'function';
  }

  async onModuleInit() {
    await this.$connect();
    if (!this.hasOptionalTable('renderJob')) {
      Object.defineProperty(this, 'renderJob', {
        configurable: true,
        get: () => {
          throw new Error('render_jobs table is not available in this deployment');
        },
      });
    }
    if (!this.hasOptionalTable('funnelEvent')) {
      Object.defineProperty(this, 'funnelEvent', {
        configurable: true,
        get: () => {
          throw new Error('funnel_events table is not available in this deployment');
        },
      });
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
