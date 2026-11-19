import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';

interface RedisClient {
  set(key: string, value: string, opts?: any): Promise<any>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<any>;
  expire(key: string, seconds: number): Promise<any>;
}

@Injectable()
export class RoomRouterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomRouterService.name);
  private readonly instanceId = randomUUID();
  private readonly localRooms = new Set<string>();
  private redis: RedisClient | null = null;
  private readonly ROOM_TTL_SECONDS = 7200;

  async onModuleInit() {
    this.logger.log(`Instance ${this.instanceId} ready for room routing`);
  }

  setRedis(redis: RedisClient) {
    this.redis = redis;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  async claimRoom(roomId: string): Promise<boolean> {
    this.localRooms.add(roomId);

    if (!this.redis) {
      return true;
    }

    const key = `room:owner:${roomId}`;
    const result = await this.redis.set(key, this.instanceId, { NX: true, EX: this.ROOM_TTL_SECONDS });
    if (result === 'OK') {
      return true;
    }

    const currentOwner = await this.redis.get(key);
    return currentOwner === this.instanceId;
  }

  async getRoomOwner(roomId: string): Promise<string | null> {
    if (!this.redis) {
      return this.localRooms.has(roomId) ? this.instanceId : null;
    }

    return this.redis.get(`room:owner:${roomId}`);
  }

  async isLocalRoom(roomId: string): Promise<boolean> {
    const owner = await this.getRoomOwner(roomId);
    return owner === this.instanceId;
  }

  async releaseRoom(roomId: string) {
    this.localRooms.delete(roomId);

    if (!this.redis) return;

    const key = `room:owner:${roomId}`;
    const owner = await this.redis.get(key);
    if (owner === this.instanceId) {
      await this.redis.del(key);
    }
  }

  async refreshTTL(roomId: string) {
    if (!this.redis) return;
    await this.redis.expire(`room:owner:${roomId}`, this.ROOM_TTL_SECONDS);
  }

  async onModuleDestroy() {
    if (!this.redis) return;
    const releasePromises = [...this.localRooms].map(roomId => this.releaseRoom(roomId));
    await Promise.allSettled(releasePromises);
    this.localRooms.clear();
  }
}
