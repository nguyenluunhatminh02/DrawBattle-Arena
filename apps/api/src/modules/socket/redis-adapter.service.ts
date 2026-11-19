import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server } from 'socket.io';

@Injectable()
export class RedisAdapterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisAdapterService.name);
  private pubClient: ReturnType<typeof createClient> | null = null;
  private subClient: ReturnType<typeof createClient> | null = null;
  private server: Server | null = null;

  async onModuleInit() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      this.logger.warn('REDIS_URL not set, running in single-instance mode');
      return;
    }

    try {
      this.pubClient = createClient({ url: redisUrl });
      this.subClient = this.pubClient.duplicate();

      this.pubClient.on('error', err => this.logger.error('Redis Pub Client Error', err));
      this.subClient.on('error', err => this.logger.error('Redis Sub Client Error', err));

      await Promise.all([this.pubClient.connect(), this.subClient.connect()]);
      this.logger.log('Redis adapter connected (multi-instance mode)');
      this.applyAdapter();
    } catch (err) {
      this.logger.error('Failed to connect to Redis', err instanceof Error ? err.message : String(err));
      await this.pubClient?.quit().catch(() => undefined);
      await this.subClient?.quit().catch(() => undefined);
      this.pubClient = null;
      this.subClient = null;
    }
  }

  async onModuleDestroy() {
    if (this.pubClient) await this.pubClient.quit();
    if (this.subClient) await this.subClient.quit();
  }

  configureAdapter(server: Server) {
    this.server = server;
    this.applyAdapter();
  }

  private applyAdapter() {
    if (!this.server || !this.pubClient || !this.subClient) return;
    const target = this.server as unknown as {
      adapter?: (factory: unknown) => void;
      server?: { adapter?: (factory: unknown) => void };
    };
    const root = typeof target.adapter === 'function' ? target : target.server;
    if (!root || typeof root.adapter !== 'function') {
      this.logger.warn('Redis adapter: unsupported server object, staying single-instance');
      return;
    }
    root.adapter(createAdapter(this.pubClient, this.subClient));
    this.logger.log('Socket.IO Redis adapter configured');
  }

  isEnabled(): boolean {
    return this.pubClient !== null && this.subClient !== null;
  }
}
