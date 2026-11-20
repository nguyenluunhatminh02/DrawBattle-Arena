import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PrismaClient already exposes typed delegates for renderJob and funnelEvent
 * after `prisma generate`. Keep feature detection so an older deployment with
 * a stale generated client can still fall back safely.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
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
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
