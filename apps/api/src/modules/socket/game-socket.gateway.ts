import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { RoomService } from '../room/room.service';
import {
  GameStateService,
  isSettingsUpdateFailure,
  RoomEvent,
} from '../game/game-state.service';
import { RedisAdapterService } from './redis-adapter.service';
import { validateStrokeCoordinates } from '@drawbattle/shared';
import type { StrokeChunk } from '@drawbattle/shared';
import { containsProfanity } from '../../common/profanity';

interface DisconnectTimer {
  timer: NodeJS.Timeout;
  roomId: string;
  playerId: string;
  socketId: string;
  generation?: number;
}

/**
 * Monotonic membership generation. A pending async leave can only evict or
 * restore the slot it originally owned; a replacement socket registers a new
 * generation, so the older operation becomes a no-op after its awaits.
 */
interface ActiveMembership {
  generation: number;
  socketId: string;
  /** Password accepted for this slot's live join, kept only for DB compensation. */
  verifiedPassword?: string;
}

interface JoinBuild {
  roomId: string;
  roomCode: string;
  playerId: string;
  generation: number;
  joinedPlayer: NonNullable<ReturnType<GameStateService['addPlayer']>>;
}

/**
 * Per-attempt ownership. Each join has its own token so an older attempt can
 * always end (and roll back only) itself, even after a newer attempt exists.
 */
interface JoinAttempt {
  generation: number;
  socketId: string;
  roomId: string;
  /** Verified identity from the socket session, used before playerId is known. */
  identityKey?: string;
  playerId?: string;
  /**
   * Password supplied by this socket's live join, later verified by
   * RoomService.joinRoom. Kept in host memory only so compensation can reuse
   * already-validated credentials; never emitted or logged.
   */
  verifiedPassword?: string;
  invalidated: boolean;
  disconnected: boolean;
  dbRowOwned: boolean;
}

interface JoinTarget {
  generation: number;
  socketId: string;
  roomId: string;
  playerId?: string;
  identityKey?: string;
}

interface AuthedSocket extends Socket {
  data: {
    identityType?: 'guest' | 'user';
    sessionId?: string;
    userId?: string;
    nickname?: string;
    playerId?: string;
    roomId?: string;
    roomCode?: string;
  };
}

@WebSocketGateway({
  cors: {
    origin: (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:3002')
      .split(',')
      .map(o => o.trim()),
    credentials: true,
  },
  namespace: '/game',
})
export class GameSocketGateway
  implements OnGatewayInit, OnGatewayConnection<AuthedSocket>, OnGatewayDisconnect<AuthedSocket>
{
  private readonly logger = new Logger(GameSocketGateway.name);
  private readonly roomSockets = new Map<string, Map<string, AuthedSocket>>();
  /** Ownership tokens for committed player slots, keyed by room + player. */
  private readonly activeMemberships = new Map<string, ActiveMembership>();
  /** Newest in-flight join token per socket. */
  private readonly joinAttempts = new Map<string, number>();
  /** All in-flight attempts, keyed by their own token. */
  private readonly joinAttemptStates = new Map<number, JoinAttempt>();
  /** Per-attempt targets keyed by token, so overlapping joins stay visible. */
  private readonly joinAttemptTargets = new Map<number, JoinTarget>();
  private membershipGeneration = 0;
  private readonly disconnectTimers = new Map<string, DisconnectTimer>();
  private readonly kickedSessions = new Map<string, Set<string>>();
  private readonly rateLimits = new Map<string, { count: number; resetAt: number }>();
  private rateLimitCleanupInterval: NodeJS.Timeout | null = null;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly roomService: RoomService,
    private readonly game: GameStateService,
    private readonly redisAdapter: RedisAdapterService,
  ) {}

  afterInit(server: Server) {
    this.redisAdapter.configureAdapter(server);
    this.rateLimitCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.rateLimits) {
        if (bucket.resetAt < now) {
          this.rateLimits.delete(key);
        }
      }
    }, 300000);
  }

  async handleConnection(socket: AuthedSocket) {
    let token = socket.handshake.auth?.token as string | undefined;

    if (!token) {
      const authHeader = socket.handshake.headers.authorization?.toString();
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const extracted = authHeader.substring(7);
        if (extracted && !extracted.includes(' ')) {
          token = extracted;
        }
      }
    }

    if (!token) {
      socket.disconnect();
      return;
    }

    // Try guest token first
    const guestSession = await this.auth.validateGuestToken(token);
    if (guestSession) {
      socket.data.identityType = 'guest';
      socket.data.sessionId = guestSession.sessionId;
      socket.data.nickname = guestSession.nickname;
      return;
    }

    // Fall back to regular JWT validation
    const userSession = await this.auth.validateUserToken(token);
    if (userSession) {
      socket.data.identityType = 'user';
      socket.data.userId = userSession.userId;
      socket.data.sessionId = userSession.userId;
      socket.data.nickname = userSession.nickname;
      return;
    }

    socket.disconnect();
  }

  /**
   * A reconnect may install a new timer for the same player while an older
   * socket is still finishing its disconnect. Only the matching room/player/
   * socket identity may clear a timer; otherwise a stale duplicate socket
   * would cancel the live socket's grace period. A generation is checked too
   * when the caller knows the membership generation it intends to cancel.
   */
  private clearDisconnectTimer(
    roomId: string,
    playerId: string,
    socketId?: string,
    generation?: number,
  ): boolean {
    const key = GameSocketGateway.disconnectTimerKey(roomId, playerId);
    const current = this.disconnectTimers.get(key);
    if (!current) return false;
    if (socketId !== undefined && current.socketId !== socketId) {
      return false;
    }
    if (generation !== undefined && current.generation !== undefined &&
        current.generation !== generation) {
      return false;
    }
    clearTimeout(current.timer);
    this.disconnectTimers.delete(key);
    return true;
  }

  private static membershipKey(roomId: string, playerId: string): string {
    return `${roomId}\u0000${playerId}`;
  }

  /** Grace timers are scoped by room and player: switching rooms never cancels another room's timer. */
  private static disconnectTimerKey(roomId: string, playerId: string): string {
    return GameSocketGateway.membershipKey(roomId, playerId);
  }

  /** Read the current ownership token for a player slot. */
  private getMembership(roomId: string, playerId: string): ActiveMembership | undefined {
    return this.activeMemberships.get(GameSocketGateway.membershipKey(roomId, playerId));
  }

  /**
   * A socket is a member of at most one game room at a time. Every action
   * handler relies on this exact socket-id match so a superseded socket can
   * never act on behalf of the player whose identity it used to carry.
   */
  private isActiveMember(socket: AuthedSocket, roomId: string, playerId: string): boolean {
    if (socket.data.roomId !== roomId || socket.data.playerId !== playerId) return false;
    if (!socket.rooms.has(roomId)) return false;
    if (this.roomSockets.get(roomId)?.get(playerId)?.id !== socket.id) return false;
    // The generation token guards async handoffs. When no token exists (e.g.
    // a state restored without an in-flight join), the socket-id match above
    // remains the authoritative ownership check.
    const membership = this.getMembership(roomId, playerId);
    return !membership || membership.socketId === socket.id;
  }

  /** Claim the slot for a new socket and bump its generation. */
  private claimMembership(
    roomId: string,
    playerId: string,
    socketId: string,
    verifiedPassword?: string,
  ): number {
    const generation = ++this.membershipGeneration;
    this.activeMemberships.set(GameSocketGateway.membershipKey(roomId, playerId), {
      generation,
      socketId,
      verifiedPassword,
    });
    return generation;
  }

  /** Reserve a token for an in-flight join before any DB await. */
  private beginJoinAttempt(socket: AuthedSocket, roomId: string, password?: string): number {
    const generation = ++this.membershipGeneration;
    const identityKey = socket.data.sessionId || socket.data.userId;
    this.joinAttempts.set(socket.id, generation);
    this.joinAttemptStates.set(generation, {
      generation,
      socketId: socket.id,
      roomId,
      identityKey,
      verifiedPassword: password,
      invalidated: false,
      disconnected: socket.disconnected === true,
      dbRowOwned: false,
    });
    // Register the target before the DB await using only verified identity.
    // A competing join can invalidate it even before the player id is known.
    this.joinAttemptTargets.set(generation, {
      generation,
      socketId: socket.id,
      roomId,
      identityKey,
    });
    // A newer join from the same verified identity supersedes older in-flight
    // attempts for that identity immediately - before either DB await resolves.
    if (identityKey) {
      for (const target of this.joinAttemptTargets.values()) {
        if (target.generation === generation || target.roomId !== roomId ||
            target.identityKey !== identityKey) {
          continue;
        }
        this.invalidateJoinAttempt(target.generation);
      }
    }
    return generation;
  }

  /** Refine an attempt's target with the player slot from the verified lookup. */
  private setJoinAttemptTarget(
    generation: number,
    roomId: string,
    playerId: string,
  ): void {
    const attempt = this.joinAttemptStates.get(generation);
    if (!attempt) return;
    attempt.playerId = playerId;
    this.joinAttemptTargets.set(generation, {
      generation,
      socketId: attempt.socketId,
      roomId,
      playerId,
      identityKey: attempt.identityKey,
    });
  }

  private getJoinAttempt(generation: number): JoinAttempt | undefined {
    return this.joinAttemptStates.get(generation);
  }

  private ownsJoinAttempt(socketId: string, generation: number): boolean {
    const attempt = this.joinAttemptStates.get(generation);
    return !!attempt && attempt.socketId === socketId && !attempt.invalidated &&
      this.joinAttempts.get(socketId) === generation;
  }

  /** Invalidate one attempt without affecting a newer attempt on the same socket. */
  private invalidateJoinAttempt(generation: number): void {
    const attempt = this.joinAttemptStates.get(generation);
    if (!attempt) return;
    attempt.invalidated = true;
    if (this.joinAttempts.get(attempt.socketId) === generation) {
      this.joinAttempts.delete(attempt.socketId);
    }
  }

  /** End only this attempt's token; never delete a newer attempt's target. */
  private endJoinAttempt(socketId: string, generation: number): void {
    const attempt = this.joinAttemptStates.get(generation);
    if (!attempt || attempt.socketId !== socketId) return;
    if (this.joinAttempts.get(socketId) === generation) {
      this.joinAttempts.delete(socketId);
    }
    this.joinAttemptTargets.delete(generation);
    this.joinAttemptStates.delete(generation);
  }

  /**
   * Invalidate in-flight joins for the same room/player slot or verified session
   * on other sockets. Targets are registered before the DB await, so an older
   * join resolving later is invisible to commit and cannot revoke this socket.
   */
  private invalidateJoinAttemptsForPlayer(
    roomId: string,
    playerId: string,
    keepSocketId: string,
    keepGeneration: number,
  ): void {
    // The verified session identity determines the player slot: joinRoom maps
    // one identity to one row per room, so matching room + identity is enough
    // even before a player id is returned by the DB.
    const ownerSocket = this.roomSockets.get(roomId)?.get(playerId);
    for (const target of this.joinAttemptTargets.values()) {
      if (target.socketId === keepSocketId || target.roomId !== roomId) continue;
      const sameIdentity = !!target.identityKey && (
        target.identityKey === ownerSocket?.data.sessionId ||
        target.identityKey === ownerSocket?.data.userId ||
        target.identityKey === this.joinAttemptStates.get(keepGeneration)?.identityKey
      );
      if (target.playerId === playerId || sameIdentity) {
        this.invalidateJoinAttempt(target.generation);
      }
    }
  }

  /** A slot may be claimed only if no replacement socket has taken it. */
  private canClaimMembership(roomId: string, playerId: string, socketId: string): boolean {
    const owner = this.getMembership(roomId, playerId);
    return !owner || owner.socketId === socketId;
  }

  /** Release a slot only when this socket is still its owner. */
  private releaseMembershipIfOwner(roomId: string, playerId: string, socketId: string): void {
    if (this.getMembership(roomId, playerId)?.socketId === socketId) {
      this.activeMemberships.delete(GameSocketGateway.membershipKey(roomId, playerId));
    }
  }

  /**
   * Commit every socket-side mutation of a join atomically (relative to other
   * handlers, which never interleave inside this synchronous method). Called
   * only after all awaits, DB membership and in-memory game state are ready.
   */
  private commitJoin(socket: AuthedSocket, build: JoinBuild): boolean {
    const { roomId, playerId, roomCode, generation, joinedPlayer } = build;
    const verifiedPassword = this.getJoinAttempt(generation)?.verifiedPassword;
    // Another socket may have claimed this player slot during an await.
    if (!this.canClaimMembership(roomId, playerId, socket.id)) return false;
    if (!this.ownsJoinAttempt(socket.id, generation)) return false;
    if (socket.disconnected) return false;
    this.claimMembership(roomId, playerId, socket.id, verifiedPassword);
    // Only cancel the grace timer owned by this socket; a timer for a
    // different socket must keep its period.
    this.clearDisconnectTimer(roomId, playerId, socket.id);
    socket.data.playerId = playerId;
    socket.data.roomId = roomId;
    socket.data.roomCode = roomCode;
    socket.join(roomId);
    let map = this.roomSockets.get(roomId);
    if (!map) {
      map = new Map();
      this.roomSockets.set(roomId, map);
    }
    map.set(playerId, socket);
    socket.emit('room:snapshot', {
      ...this.game.getSnapshot(roomId)!,
      code: roomCode,
      yourPlayerId: playerId,
    });
    this.server.to(roomId).emit('room:playerJoined', {
      id: playerId,
      nickname: socket.data.nickname,
      isHost: joinedPlayer.isHost,
      isReady: joinedPlayer.isReady,
      isOnline: joinedPlayer.isOnline,
      score: joinedPlayer.score,
    });
    this.broadcastRoomUpdate(roomId);
    const turn = this.game.getTurnSnapshot(roomId);
    if (turn) {
      socket.emit('turn:restore', turn);
      const word = this.game.getDrawerWord(roomId, playerId);
      if (word) socket.emit('turn:yourWord', { word });
    }
    const attempt = this.getJoinAttempt(generation);
    if (attempt) attempt.dbRowOwned = false;
    return true;
  }

  /**
   * Revoke a superseded socket without touching game state or the DB row:
   * the new socket takes over the same player slot. Removing the old socket
   * from roomSockets and clearing its data makes every guarded handler reject
   * it, and cancelling its grace timer prevents a stale disconnect from
   * evicting the replacement.
   */
  private revokeReplacedSocket(oldSocket: AuthedSocket, roomId: string, playerId: string): void {
    const membership = this.getMembership(roomId, playerId);
    this.releaseMembershipIfOwner(roomId, playerId, oldSocket.id);
    this.clearDisconnectTimer(roomId, playerId, oldSocket.id, membership?.generation);
    const roomMap = this.roomSockets.get(roomId);
    if (roomMap?.get(playerId)?.id === oldSocket.id) {
      roomMap.delete(playerId);
      if (roomMap.size === 0) this.roomSockets.delete(roomId);
    }
    oldSocket.leave(roomId);
    oldSocket.emit('session:replaced', { roomId });
    oldSocket.data.roomId = undefined;
    oldSocket.data.roomCode = undefined;
    oldSocket.data.playerId = undefined;
  }

  /**
   * Detach a socket from a room it is leaving for a different room. The DB
   * row and in-memory slot are released immediately so the abandoned slot
   * cannot keep the room full or accept a password-free rejoin. The owner's
   * identity captured before the await is rechecked before every mutation: a
   * replacement socket registered mid-write can never be evicted by this
   * older leave.
   */
  private async leaveCurrentRoom(
    socket: AuthedSocket,
  ): Promise<{ roomId: string; playerId: string; roomCode?: string; socketId: string } | null> {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return null;
    const ownerSocketId = socket.id;
    const roomCode = socket.data.roomCode;
    const membershipGeneration = this.getMembership(roomId, playerId)?.generation;

    // Persist the departure before releasing in-memory state so a rejected
    // write aborts the switch and leaves the old membership intact.
    await this.roomService.leaveRoom(roomId, playerId);

    // Recheck ownership after the await: a replacement socket may own this
    // slot now. In that case the DB leave is correct, but no local state of
    // the replacement may be touched.
    const currentMembership = this.getMembership(roomId, playerId);
    if (currentMembership && currentMembership.socketId !== ownerSocketId) return null;
    this.activeMemberships.delete(GameSocketGateway.membershipKey(roomId, playerId));
    this.clearDisconnectTimer(roomId, playerId, socket.id, membershipGeneration);
    this.game.removePlayer(roomId, playerId);
    const roomMap = this.roomSockets.get(roomId);
    if (roomMap?.get(playerId)?.id === socket.id) {
      roomMap.delete(playerId);
      if (roomMap.size === 0) this.roomSockets.delete(roomId);
    }
    socket.leave(roomId);
    this.server.to(roomId).emit('room:playerLeft', playerId);
    this.broadcastRoomUpdate(roomId);
    socket.emit('room:left');
    socket.data.roomId = undefined;
    socket.data.roomCode = undefined;
    socket.data.playerId = undefined;
    return { roomId, playerId, roomCode, socketId: ownerSocketId };
  }

  /**
   * A stale grace timer may have persisted a leave for a row that a newer
   * socket already took over. Reactivate that row through the idempotent rejoin
   * path: it returns immediately when the row is already active and only
   * reactivates the same player's left row otherwise. Any failure is logged so
   * the caller never masks the original timer outcome.
   */
  private async reactivateLeftDbRow(
    socket: AuthedSocket,
    roomId: string,
    playerId: string,
    password?: string,
  ): Promise<void> {
    const roomCode = socket.data.roomCode;
    const nickname = socket.data.nickname;
    if (!roomCode || !nickname) return;
    try {
      const rejoined = await this.roomService.joinRoom(
        roomCode,
        nickname,
        socket.data.identityType === 'guest' ? socket.data.sessionId! : null,
        socket.data.identityType === 'user' ? socket.data.userId! : null,
        password,
      );
      if (rejoined.roomId !== roomId || rejoined.playerId !== playerId) {
        this.logger.warn(`Could not reactivate superseded row for ${playerId}: wrong membership`);
      }
    } catch (err) {
      this.logger.error(
        'Failed to reactivate a superseded room player row',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * True when this attempt still owns the row it reactivated in the previous
   * room. A concurrent kick (identity denylist) or a newer socket taking the
   * slot must never be undone by the rollback of a failed rejoin.
   */
  private ownsRestoredDbRow(
    socket: AuthedSocket,
    roomId: string,
    playerId: string,
    attempt: JoinAttempt | undefined,
    membershipBefore: ActiveMembership | undefined,
  ): boolean {
    if (!attempt || !attempt.dbRowOwned || attempt.socketId !== socket.id) return false;
    if (this.getJoinAttempt(attempt.generation) !== attempt) return false;
    const membership = this.getMembership(roomId, playerId);
    if (membershipBefore && membership?.generation !== membershipBefore.generation) return false;
    if (membership && membership.socketId !== socket.id) return false;
    const registeredSocket = this.roomSockets.get(roomId)?.get(playerId);
    if (registeredSocket && registeredSocket.id !== socket.id) return false;
    const identity = socket.data.sessionId || socket.data.userId;
    if (identity && this.kickedSessions.get(roomId)?.has(identity)) return false;
    return true;
  }

  /**
   * Best-effort restoration after a failed destination join. Only the socket
   * that completed the old leave is allowed to reclaim that room; a newer
   * replacement keeps its slot. Any in-memory result is rolled back if the
   * DB rejoin fails, so no active row is left without a socket.
   */
  private async restorePreviousRoom(
    socket: AuthedSocket,
    previous: { roomId: string; playerId: string; roomCode?: string; socketId: string },
    attemptGeneration: number,
  ): Promise<boolean> {
    const { roomId, playerId, roomCode, socketId } = previous;
    if (!this.ownsJoinAttempt(socket.id, attemptGeneration)) return false;
    if (socket.disconnected) return false;
    if (this.getMembership(roomId, playerId) && this.getMembership(roomId, playerId)!.socketId !== socketId) {
      return false;
    }
    const nickname = socket.data.nickname;
    if (!nickname) return false;
    const attempt = this.getJoinAttempt(attemptGeneration);
    if (!attempt) return false;
    const membershipBefore = this.getMembership(roomId, playerId);
    // Mark ownership before the DB await so a rollback can never release a row
    // that a concurrent leave/kick already took away from this attempt.
    attempt.dbRowOwned = true;
    try {
      const rejoined = await this.roomService.joinRoom(
        roomCode ?? '',
        nickname,
        socket.data.identityType === 'guest' ? socket.data.sessionId! : null,
        socket.data.identityType === 'user' ? socket.data.userId! : null,
      );
      if (!this.ownsJoinAttempt(socket.id, attemptGeneration)) return false;
      if (socket.disconnected) return false;
      if (rejoined.roomId !== roomId || rejoined.playerId !== playerId) {
        throw new Error('Rejoin returned a different membership');
      }
      // A newer socket may have claimed this slot while the rejoin was in
      // flight. Never revoke it or roll back its row from this older attempt.
      if (!this.ownsRestoredDbRow(socket, roomId, playerId, attempt, membershipBefore)) {
        return false;
      }
      const existing = this.roomSockets.get(roomId)?.get(playerId);
      if (existing && existing.id !== socket.id) {
        this.revokeReplacedSocket(existing, roomId, playerId);
      }
      const player = this.game.addPlayer(roomId, playerId, nickname);
      if (!player) throw new Error('Restored room is full');
      this.game.registerSink(roomId, (event: RoomEvent) => this.dispatchRoomEvent(roomId, event));
      this.commitJoin(socket, {
        roomId,
        playerId,
        roomCode: roomCode ?? '',
        generation: attemptGeneration,
        joinedPlayer: player,
      });
      attempt.dbRowOwned = false;
      return true;
    } catch (err) {
      this.logger.error(
        'Failed to restore previous room after aborted switch',
        err instanceof Error ? err.message : String(err),
      );
      // Roll back only the row this attempt reactivated and still owns. A newer
      // attempt, a kick or a concurrent leave must not have its slot released.
      if (this.ownsRestoredDbRow(socket, roomId, playerId, attempt, membershipBefore)) {
        try {
          await this.roomService.leaveRoom(roomId, playerId);
          attempt.dbRowOwned = false;
        } catch (rollbackErr) {
          this.logger.error(
            'Failed to roll back restored room membership',
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          );
        }
      }
      this.releaseMembershipIfOwner(roomId, playerId, socket.id);
      socket.data.roomId = undefined;
      socket.data.playerId = undefined;
      socket.data.roomCode = undefined;
      return false;
    }
  }

  handleDisconnect(socket: AuthedSocket) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    const sessionId = socket.data.sessionId;
    const membership = roomId && playerId ? this.getMembership(roomId, playerId) : undefined;

    // A socket that disconnects while its join is in flight must abort that
    // join. The DB row is rolled back by the join's own failure path, which
    // rechecks this flag after every await.
    for (const attempt of this.joinAttemptStates.values()) {
      if (attempt.socketId !== socket.id) continue;
      if (roomId && playerId && attempt.playerId &&
          (attempt.roomId !== roomId || attempt.playerId !== playerId)) {
        continue;
      }
      attempt.disconnected = true;
      this.invalidateJoinAttempt(attempt.generation);
    }

    if (roomId && playerId) {
      const roomMap = this.roomSockets.get(roomId);
      const currentSocket = roomMap?.get(playerId);
      const pendingTimer = this.disconnectTimers.get(
        GameSocketGateway.disconnectTimerKey(roomId, playerId),
      );
      // Only the socket still registered as this player's active member may
      // tear down membership. A replaced (or already evicted) socket must not
      // mark the live socket offline, cancel its grace timer or delete it from
      // roomSockets. This also gates the shared rate-limit buckets below.
      if (!currentSocket || currentSocket.id !== socket.id) return;
      if (membership && membership.socketId !== socket.id) return;
      if (pendingTimer && (pendingTimer.roomId !== roomId || pendingTimer.socketId !== socket.id)) {
        return;
      }
    }

    for (const [key] of this.rateLimits) {
      if (key.endsWith(`:${playerId}`) || key.endsWith(`:${sessionId}`) || key.endsWith(`:${socket.id}`)) {
        this.rateLimits.delete(key);
      }
    }

    if (roomId && playerId) {
      const generation = membership?.generation;
      const ownerSocketId = socket.id;
      // The grace period is owned by this exact socket and generation; a
      // replacement socket registers a new generation and cancels the timer.
      this.game.setPlayerOnline(roomId, playerId, false);
      const roomMap = this.roomSockets.get(roomId);
      if (roomMap) {
        roomMap.delete(playerId);
        if (roomMap.size === 0) {
          this.roomSockets.delete(roomId);
        }
      }
      this.broadcastRoomUpdate(roomId);
      const timerKey = GameSocketGateway.disconnectTimerKey(roomId, playerId);
      const timer = setTimeout(async () => {
        // A reconnect may have already replaced this socket before the timer
        // callback started. Never persist a leave for a row that now belongs
        // to a newer socket - the DB write would mark the winner's row left.
        const beforeMembership = this.getMembership(roomId, playerId);
        if (
          (beforeMembership && (beforeMembership.socketId !== ownerSocketId ||
            (generation !== undefined && beforeMembership.generation !== generation))) ||
          this.disconnectTimers.get(timerKey) !== current
        ) {
          if (current === this.disconnectTimers.get(timerKey)) {
            this.disconnectTimers.delete(timerKey);
          }
          return;
        }
        // Persist the departure before freeing the slot. Without this the
        // player keeps leftAt=null in DB, occupies a slot forever and can
        // rejoin a password-protected room without supplying the password.
        let leaveFailed = false;
        try {
          await this.roomService.leaveRoom(roomId, playerId);
        } catch (err) {
          leaveFailed = true;
          this.logger.error(
            'Failed to persist player departure',
            err instanceof Error ? err.message : String(err),
          );
        }
        // Re-check after every await. A reconnect may have installed a new
        // socket (and generation) while leaveRoom was in flight; only the
        // timer's original owner may complete the eviction. If the leave
        // committed for a row a newer socket took over, reactivate that row
        // instead of leaving the winner soft-deleted in the DB.
        const currentMembership = this.getMembership(roomId, playerId);
        if (
          (currentMembership && (currentMembership.socketId !== ownerSocketId ||
            (generation !== undefined && currentMembership.generation !== generation))) ||
          this.disconnectTimers.get(timerKey) !== current
        ) {
          if (!leaveFailed) {
            // Reuse only credentials stored with the membership that won this
            // slot. Attempt tokens are gone after commit; the disconnected
            // socket's credentials are never used for compensation.
            const winner = this.getMembership(roomId, playerId);
            await this.reactivateLeftDbRow(socket, roomId, playerId, winner?.verifiedPassword);
          }
          return;
        }
        this.activeMemberships.delete(GameSocketGateway.membershipKey(roomId, playerId));
        this.game.removePlayer(roomId, playerId);
        this.server.to(roomId).emit('room:playerLeft', playerId);
        this.broadcastRoomUpdate(roomId);
        if (current === this.disconnectTimers.get(timerKey)) {
          this.disconnectTimers.delete(timerKey);
        }
        socket.data.roomId = undefined;
        socket.data.playerId = undefined;
      }, 15_000);
      // A newer socket for this player supersedes any older timer in THIS room.
      this.clearDisconnectTimer(roomId, playerId, ownerSocketId);
      const current: DisconnectTimer = {
        timer,
        roomId,
        playerId,
        socketId: ownerSocketId,
        generation,
      };
      this.disconnectTimers.set(timerKey, current);
    }
  }

  @SubscribeMessage('room:join')
  async onRoomJoin(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() data: { roomCode: string; nickname?: string; password?: string },
  ) {
    try {
      if (!socket.data.sessionId || !socket.data.nickname) {
        const token = socket.handshake.auth?.token as string | undefined;
        const session = token ? await this.auth.validateGuestToken(token) : null;
        if (session?.nickname) {
          socket.data.identityType = 'guest';
          socket.data.sessionId = session.sessionId;
          socket.data.nickname = session.nickname;
        } else {
          const user = token ? await this.auth.validateUserToken(token) : null;
          if (!user?.nickname) {
            socket.emit('error', 'UNAUTHORIZED', 'Not authenticated');
            return;
          }
          socket.data.identityType = 'user';
          socket.data.userId = user.userId;
          socket.data.sessionId = user.userId;
          socket.data.nickname = user.nickname;
        }
      }

      // Nickname is bound to the verified token. Never trust a client-supplied
      // value here: it bypassed account-creation validation and profanity checks.
      const nickname = socket.data.nickname;
      if (!nickname) {
        socket.emit('error', 'INVALID_PAYLOAD', 'Missing nickname');
        return;
      }

      if (typeof data?.roomCode !== 'string' || !data.roomCode.trim()) {
        socket.emit('error', 'INVALID_PAYLOAD', 'Missing room code');
        return;
      }
      const roomCode = data.roomCode.trim().toUpperCase();

      const room = await this.roomService.getRoomInfo(roomCode);
      // Denylist is keyed by roomId so a kick in one room cannot ban the
      // identity from an unrelated room that happens to reuse the code.
      const banned = this.kickedSessions.get(room.id);
      const identity = socket.data.sessionId || socket.data.userId;
      if (banned && identity && banned.has(identity)) {
        socket.emit('error', 'KICKED', 'You were kicked from this room');
        return;
      }

      // A socket may belong to at most one game room. Persist the old leave
      // before writing the destination row so a rejected leave aborts the
      // switch without touching the destination or old socket state.
      let previous: Awaited<ReturnType<GameSocketGateway['leaveCurrentRoom']>> = null;
      if (socket.data.roomId && socket.data.roomId !== room.id) {
        try {
          previous = await this.leaveCurrentRoom(socket);
        } catch (err) {
          this.logger.error(
            'Room switch aborted: could not leave previous room',
            err instanceof Error ? err.message : String(err),
          );
          socket.emit('error', 'SWITCH_FAILED', 'Could not leave the previous room');
          return;
        }
      }

      // Reserve a token before the DB await. The player slot is registered
      // right away when it is already known from this socket or the room.
      const generation = this.beginJoinAttempt(
        socket,
        room.id,
        typeof data.password === 'string' ? data.password : undefined,
      );
      const knownPlayerId = socket.data.roomId === room.id ? socket.data.playerId : undefined;
      if (knownPlayerId) {
        this.setJoinAttemptTarget(generation, room.id, knownPlayerId);
      }
      let joined: { roomId: string; roomCode: string; playerId: string } | null = null;
      let destinationCommitted = false;
      try {
        joined = await this.roomService.joinRoom(
          roomCode,
          nickname,
          socket.data.identityType === 'guest' ? socket.data.sessionId! : null,
          socket.data.identityType === 'user' ? socket.data.userId! : null,
          typeof data.password === 'string' ? data.password : undefined,
        );
        const attempt = this.getJoinAttempt(generation);
        // The DB row belongs to this attempt even when it was invalidated while
        // the join was in flight. Record ownership first so the failure path can
        // release only this row without touching a newer socket's membership.
        if (attempt) attempt.dbRowOwned = true;
        // An invalidated attempt (superseded join, or a disconnect while the
        // DB call was pending) must not commit or affect any newer socket.
        if (!attempt || attempt.invalidated || attempt.disconnected ||
            !this.ownsJoinAttempt(socket.id, generation) || socket.disconnected) {
          throw new Error('Room join superseded');
        }
        // The DB join can land while the previous socket's disconnect is still
        // pending. Its grace timer (or a superseded join's rollback) must never
        // persist a leave for the slot this attempt just acquired.
        this.clearDisconnectTimer(joined.roomId, joined.playerId, undefined, undefined);
        this.setJoinAttemptTarget(generation, joined.roomId, joined.playerId);
        // An in-flight join from the socket being replaced can still be inside
        // its own DB await. Supersede it here so its rollback cannot release
        // this attempt's freshly written row when it resumes.
        this.invalidateJoinAttemptsForPlayer(joined.roomId, joined.playerId, socket.id, generation);

        // A disconnected socket leaves behind its membership token until the
        // grace timer fires. It must not make this live reconnect look like a
        // replacement of a socket that is no longer active.
        if (!this.canClaimMembership(joined.roomId, joined.playerId, socket.id)) {
          const owner = this.getMembership(joined.roomId, joined.playerId);
          if (owner) {
            const ownerSocket = this.roomSockets.get(joined.roomId)?.get(joined.playerId);
            if (!ownerSocket || (ownerSocket.id !== owner.socketId && ownerSocket.id !== socket.id)) {
              this.releaseMembershipIfOwner(joined.roomId, joined.playerId, owner.socketId);
            }
          }
        }

        // When the same identity reconnects with a new socket, revoke the old
        // socket rather than leaving two sockets able to act for one player.
        // The player slot and DB row stay intact; the new socket takes over.
        const existingSocket = this.roomSockets.get(joined.roomId)?.get(joined.playerId);
        if (existingSocket && existingSocket.id !== socket.id) {
          this.revokeReplacedSocket(existingSocket, joined.roomId, joined.playerId);
        }
        // If a newer attempt owns this slot, abandon this one through the
        // shared failure path: its DB row must be released but the newer
        // socket's state must not be modified.
        if (!this.canClaimMembership(joined.roomId, joined.playerId, socket.id)) {
          throw new Error('Room join superseded');
        }
        this.claimMembership(joined.roomId, joined.playerId, socket.id, attempt.verifiedPassword);

        if (!this.game.getSnapshot(joined.roomId)) {
          const dbRoom = await this.roomService.getRoomById(joined.roomId);
          if (!this.ownsJoinAttempt(socket.id, generation)) throw new Error('Room join superseded');
          if (attempt.disconnected || socket.disconnected) throw new Error('Room join superseded');
          if (dbRoom.status === 'PLAYING') {
            await this.roomService.resetRoomStatus(joined.roomId);
            if (!this.ownsJoinAttempt(socket.id, generation)) throw new Error('Room join superseded');
            socket.emit('match:cancelled', { reason: 'SERVER_RESTART' });
          }
          const activePlayers = dbRoom.players;
          const hostId =
            dbRoom.hostPlayerId && activePlayers.some(p => p.id === dbRoom.hostPlayerId)
              ? dbRoom.hostPlayerId
              : joined.playerId;
          if (hostId !== dbRoom.hostPlayerId) {
            await this.roomService.updateHost(joined.roomId, hostId);
            if (!this.ownsJoinAttempt(socket.id, generation)) throw new Error('Room join superseded');
          }
          const hostNickname =
            activePlayers.find(p => p.id === hostId)?.nicknameSnapshot ?? nickname;
          this.game.initRoom(
            joined.roomId,
            hostId,
            hostNickname,
            dbRoom.settings as never,
          );
          for (const p of activePlayers) {
            this.game.addPlayer(joined.roomId, p.id, p.nicknameSnapshot);
          }
        }
        const joinedPlayer = this.game.addPlayer(joined.roomId, joined.playerId, nickname);
        if (!joinedPlayer) {
          // addPlayer returned null because the in-memory room is at capacity.
          // Route through the shared failure path so the persisted row is
          // released and an old room (if any) is restored.
          throw new Error('Room is full');
        }
        const destinationRoomId = joined.roomId;
        this.game.registerSink(destinationRoomId, (event: RoomEvent) => {
          this.dispatchRoomEvent(destinationRoomId, event);
        });
        if (!this.commitJoin(socket, {
          roomId: joined.roomId,
          roomCode,
          playerId: joined.playerId,
          generation,
          joinedPlayer,
        })) {
          throw new Error('Room join superseded');
        }
        destinationCommitted = true;
      } catch (err) {
        // Any failed await after the DB row was created must release it, but
        // only when this attempt still owns that row. A newer attempt may have
        // taken the same player slot while this one was awaiting.
        const attempt = this.getJoinAttempt(generation);
        const owner = joined ? this.getMembership(joined.roomId, joined.playerId) : undefined;
        // An invalidated attempt still owns its own DB row when no other socket
        // holds that slot (e.g. a competing join lost the race). Never roll
        // back a row that a newer, live socket has committed.
        const rollbackRow = !!(joined && !destinationCommitted && attempt?.dbRowOwned &&
          (!owner || owner.socketId === socket.id));
        if (rollbackRow && joined) {
          try {
            await this.roomService.leaveRoom(joined.roomId, joined.playerId);
          } catch (rollbackErr) {
            this.logger.error(
              'Failed to roll back destination room membership',
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            );
          }
        }
        if (joined) this.releaseMembershipIfOwner(joined.roomId, joined.playerId, socket.id);
        // Keep the attempt token alive until restore completes: restore uses it
        // to prove no newer join has superseded this socket during its awaits.
        const restored = previous ? await this.restorePreviousRoom(socket, previous, generation) : false;
        this.endJoinAttempt(socket.id, generation);
        if (previous && !restored) {
          socket.emit('error', 'SWITCH_FAILED', 'Could not join room or restore the previous room');
          return;
        }
        throw err;
      } finally {
        // Every attempt ends its own token, even when invalidated, superseded
        // or aborted by a disconnect. endJoinAttempt never deletes a newer one.
        this.endJoinAttempt(socket.id, generation);
      }
    } catch (err) {
      const internalMessage = err instanceof Error ? err.message : String(err);
      const lower = internalMessage.toLowerCase();
      // Map only the known join-domain failures to fixed, client-safe codes and
      // messages. Never forward an internal err.message to socket clients: it
      // can contain SQL/Prisma details, credentials or other host internals.
      let code: string;
      let message: string;
      if (err instanceof ForbiddenException || lower.includes('kicked')) {
        code = 'KICKED';
        message = 'You were kicked from this room';
      } else if (err instanceof NotFoundException || lower.includes('not found')) {
        code = 'ROOM_NOT_FOUND';
        message = 'Room not found';
      } else if (lower.includes('password')) {
        code = 'INVALID_PASSWORD';
        message = 'Invalid password';
      } else if (lower.includes('full')) {
        code = 'ROOM_FULL';
        message = 'Room is full';
      } else if (lower.includes('progress')) {
        code = 'GAME_IN_PROGRESS';
        message = 'Game already in progress';
      } else if (lower.includes('expired')) {
        code = 'ROOM_EXPIRED';
        message = 'Room expired';
      } else {
        code = 'JOIN_FAILED';
        message = 'Could not join room';
      }
      // Log the raw error server-side for diagnosis; clients get codes only.
      this.logger.warn(`Room join failed (${code})`, internalMessage);
      socket.emit('error', code, message);
    }
  }

  @SubscribeMessage('room:leave')
  async onRoomLeave(@ConnectedSocket() socket: AuthedSocket) {
    try {
      await this.leaveCurrentRoom(socket);
    } catch (err) {
      this.logger.error(
        'Failed to leave room',
        err instanceof Error ? err.message : String(err),
      );
      socket.emit('error', 'LEAVE_FAILED', 'Could not leave the room');
    }
  }

  @SubscribeMessage('room:ready')
  onReady(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() ready: boolean,
  ) {
    // Validate the payload first: a malformed frame must always get a clear
    // error, even if it arrives from a socket with stale room data.
    if (typeof ready !== 'boolean') {
      socket.emit('error', 'INVALID_PAYLOAD', 'Invalid ready state');
      return;
    }
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    this.game.setReady(roomId, playerId, ready);
    this.broadcastRoomUpdate(roomId);
  }

  @SubscribeMessage('match:start')
  async onStart(@ConnectedSocket() socket: AuthedSocket) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    if (!this.game.isHost(roomId, playerId)) {
      socket.emit('error', 'NOT_HOST', 'Only host can start');
      return;
    }
    const check = this.game.canStartMatch(roomId, playerId);
    if (!check.ok) {
      socket.emit('error', check.reason ?? 'START_FAILED', check.message ?? 'Cannot start match');
      return;
    }
    const ok = await this.game.startMatch(roomId);
    if (!ok) {
      socket.emit('error', 'START_FAILED', 'Cannot start match');
    }
  }

  @SubscribeMessage('match:rematch')
  async onRematch(@ConnectedSocket() socket: AuthedSocket) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    if (!this.game.isHost(roomId, playerId)) {
      socket.emit('error', 'NOT_HOST', 'Only host can rematch');
      return;
    }
    const check = this.game.canStartMatch(roomId, playerId);
    if (!check.ok) {
      socket.emit('error', check.reason ?? 'REMATCH_FAILED', check.message ?? 'Cannot rematch');
      return;
    }
    const ok = await this.game.startMatch(roomId);
    if (!ok) {
      socket.emit('error', 'REMATCH_FAILED', 'Cannot rematch');
    }
  }

  @SubscribeMessage('turn:chooseWord')
  async onChooseWord(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() wordId: string,
  ) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    const ok = await this.game.chooseWord(roomId, playerId, wordId);
    if (!ok) socket.emit('error', 'INVALID_WORD', 'Cannot choose word');
  }

  @SubscribeMessage('draw:strokeStart')
  onStrokeStart(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() data: { turnId: string; strokeId: string },
  ) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    if (!data || typeof data.turnId !== 'string' || typeof data.strokeId !== 'string') {
      socket.emit('error', 'INVALID_PAYLOAD', 'Invalid stroke start');
      return;
    }
    if (!this.game.canDraw(roomId, playerId, data.turnId)) {
      socket.emit('error', 'NOT_DRAWER', 'Not allowed to draw');
      return;
    }
  }

  @SubscribeMessage('draw:strokeChunk')
  onStrokeChunk(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() chunk: StrokeChunk,
  ) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    if (!this.checkSocketRateLimit(socket, 'stroke', 30, 1000)) return;
    if (
      !chunk ||
      typeof chunk.turnId !== 'string' ||
      typeof chunk.strokeId !== 'string' ||
      !Array.isArray(chunk.points) ||
      chunk.points.length === 0 ||
      chunk.points.length > 2000 ||
      typeof chunk.color !== 'string' ||
      !/^#[0-9A-Fa-f]{6}$/.test(chunk.color) ||
      typeof chunk.width !== 'number' ||
      chunk.width < 1 ||
      chunk.width > 20 ||
      !validateStrokeCoordinates(chunk.points)
    ) {
      socket.emit('error', 'INVALID_PAYLOAD', 'Invalid stroke');
      return;
    }
    this.game.submitStroke(roomId, playerId, chunk);
  }

  @SubscribeMessage('draw:strokeEnd')
  onStrokeEnd(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() data: { turnId: string; strokeId: string },
  ) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    if (!data || typeof data.turnId !== 'string' || typeof data.strokeId !== 'string') {
      socket.emit('error', 'INVALID_PAYLOAD', 'Invalid stroke end');
      return;
    }
    if (!this.game.canDraw(roomId, playerId, data.turnId)) {
      socket.emit('error', 'NOT_DRAWER', 'Not allowed to draw');
      return;
    }
  }

  @SubscribeMessage('draw:clear')
  onDrawClear(@ConnectedSocket() socket: AuthedSocket) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    this.game.clearCanvas(roomId, playerId);
  }

  @SubscribeMessage('guess:submit')
  onGuessSubmit(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() guess: string,
  ) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    if (typeof guess !== 'string' || guess.length === 0 || guess.length > 100) {
      socket.emit('error', 'INVALID_PAYLOAD', 'Invalid guess');
      return;
    }
    if (this.game.isMuted(roomId, playerId)) {
      socket.emit('error', 'MUTED', 'You are muted');
      return;
    }
    if (!this.checkSocketRateLimit(socket, 'guess', 5, 2000)) return;
    const result = this.game.submitGuess(roomId, playerId, guess);
    if (!result.accepted) return;
    if (!result.correct) {
      socket.emit('guess:wrong');
    }
  }

  @SubscribeMessage('chat:send')
  onChat(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() message: string,
  ) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    if (typeof message !== 'string' || message.length === 0 || message.length > 200) {
      return;
    }
    if (this.game.isMuted(roomId, playerId)) {
      socket.emit('error', 'MUTED', 'You are muted');
      return;
    }
    if (!this.checkSocketRateLimit(socket, 'chat', 5, 5000)) return;
    if (containsProfanity(message)) {
      socket.emit('error', 'PROFANITY', 'Message contains inappropriate language');
      return;
    }
    this.game.sendChat(roomId, playerId, message);
  }

  @SubscribeMessage('draw:undo')
  onDrawUndo(@ConnectedSocket() socket: AuthedSocket) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    this.game.undoStroke(roomId, playerId);
  }

  @SubscribeMessage('room:hostAction')
  async onHostAction(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() data: { action: 'kick' | 'mute' | 'transferHost'; targetId: string },
  ) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !data?.targetId) return;
    if (!this.isActiveMember(socket, roomId, playerId)) return;
    if (!this.game.isHost(roomId, playerId)) {
      socket.emit('error', 'NOT_HOST', 'Only host can perform this action');
      return;
    }
    switch (data.action) {
      case 'kick': {
        const targetSocket = this.roomSockets.get(roomId)?.get(data.targetId);
        // Capture the exact socket and membership generation being kicked
        // before any await. A slow banPlayer must not cancel a grace timer
        // installed by a newer replacement socket for the same player. For an
        // already-disconnected target the pending timer is the ownership token.
        const kickedTimer = this.disconnectTimers.get(
          GameSocketGateway.disconnectTimerKey(roomId, data.targetId),
        );
        const kickedSocketId = targetSocket?.id ?? kickedTimer?.socketId;
        const kickedGeneration =
          this.getMembership(roomId, data.targetId)?.generation ?? kickedTimer?.generation;
        // Authorize the kick without mutating in-memory state first. A forged
        // or stale hostAction must never create a DB ban, and the target must
        // remain in the room until the ban is durably persisted.
        const snapshot = this.game.getSnapshot(roomId);
        if (
          !snapshot?.players.some(p => p.id === data.targetId) ||
          !this.game.isHost(roomId, playerId) ||
          playerId === data.targetId
        ) {
          socket.emit('error', 'KICK_FAILED', 'Cannot kick player');
          break;
        }
        // Resolve identities from the DB, not the socket, so offline targets
        // and token rotation cannot evade the ban. If persistence fails, do
        // not leave a kicked player who can freely rejoin.
        let banned: { userId: string | null; guestSessionId: string | null };
        try {
          banned = await this.roomService.banPlayer(roomId, data.targetId);
        } catch (err) {
          this.logger.error(
            'Failed to persist kick ban',
            err instanceof Error ? err.message : String(err),
          );
          socket.emit('error', 'KICK_FAILED', 'Failed to persist kick');
          break;
        }
        // Best-effort fast path only; joinRoom checks the DB authoritatively.
        const denylist = this.kickedSessions.get(roomId) ?? new Set<string>();
        if (banned.guestSessionId) denylist.add(banned.guestSessionId);
        if (banned.userId) denylist.add(banned.userId);
        if (banned.guestSessionId || banned.userId) {
          this.kickedSessions.set(roomId, denylist);
        }
        // Only cancel a timer (and evict a socket) that still belongs to the
        // socket kicked when this action started. A replacement that reconnected
        // during banPlayer keeps its grace period and its room membership.
        const currentTargetSocket = this.roomSockets.get(roomId)?.get(data.targetId);
        const currentTargetMembership = this.getMembership(roomId, data.targetId);
        const timerStillOwned =
          (!kickedSocketId || currentTargetSocket?.id === kickedSocketId) &&
          (!kickedGeneration ||
            (currentTargetMembership && currentTargetMembership.generation === kickedGeneration));
        if (timerStillOwned) {
          // The ban is durable, so it is now safe to remove the player from the
          // in-memory room. This also emits room:playerKicked to the target.
          this.game.kickPlayer(roomId, playerId, data.targetId);
          this.clearDisconnectTimer(roomId, data.targetId, kickedSocketId, kickedGeneration);
          this.roomSockets.get(roomId)?.delete(data.targetId);
          this.activeMemberships.delete(GameSocketGateway.membershipKey(roomId, data.targetId));
          if (targetSocket) {
            targetSocket.leave(roomId);
            targetSocket.emit('room:kicked', { roomCode: socket.data.roomCode });
            targetSocket.data.roomId = undefined;
            targetSocket.data.roomCode = undefined;
            targetSocket.data.playerId = undefined;
          }
          try {
            await this.roomService.leaveRoom(roomId, data.targetId);
          } catch (err) {
            this.logger.error(
              'Failed to persist kicked player',
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        this.broadcastRoomUpdate(roomId);
        break;
      }
      case 'mute':
        if (!this.game.mutePlayer(roomId, playerId, data.targetId, true)) {
          socket.emit('error', 'MUTE_FAILED', 'Cannot mute player');
        }
        break;
      case 'transferHost':
        if (!this.game.transferHost(roomId, playerId, data.targetId)) {
          socket.emit('error', 'TRANSFER_FAILED', 'Cannot transfer host');
        }
        break;
    }
  }

  @SubscribeMessage('room:updateSettings')
  async onUpdateSettings(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody()
    data: {
      rounds?: number;
      turnDuration?: number;
      enableHints?: boolean;
      difficulty?: string;
      category?: string;
    },
  ) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    if (!this.game.isHost(roomId, playerId)) {
      socket.emit('error', 'NOT_HOST', 'Only host can update settings');
      return;
    }
    const result = await this.game.updateSettings(roomId, playerId, data ?? {});
    if (!result.ok) {
      if (isSettingsUpdateFailure(result, 'MATCH_IN_PROGRESS')) {
        socket.emit('error', 'SETTINGS_FAILED', 'Cannot update settings during a match');
      } else if (isSettingsUpdateFailure(result, 'ROOM_REPLACED')) {
        // The DB write committed, but the room lifetime changed mid-flight
        // (e.g. delete/recreate). This is not a match conflict: use a safe
        // generic code and log only for server-side diagnosis.
        this.logger.warn(`Settings update raced a room replacement for ${roomId}`);
        socket.emit('error', 'SETTINGS_SAVE_FAILED', 'Could not save settings');
      } else {
        // A persistence failure (or any other internal reason) must not be
        // reported as a match-in-progress rejection, and DB details must never
        // reach the client. Log the fixed reason only for server-side diagnosis.
        this.logger.warn(`Settings update failed for room ${roomId}`, result.reason);
        socket.emit('error', 'SETTINGS_SAVE_FAILED', 'Could not save settings');
      }
    }
  }

  @SubscribeMessage('state:resync')
  onResync(@ConnectedSocket() socket: AuthedSocket) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    const snapshot = this.game.getSnapshot(roomId);
    if (snapshot) {
      socket.emit('room:snapshot', { ...snapshot, yourPlayerId: playerId });
    }
    const turn = this.game.getTurnSnapshot(roomId);
    if (turn) socket.emit('turn:restore', turn);
    const word = this.game.getDrawerWord(roomId, playerId);
    if (word) socket.emit('turn:yourWord', { word });
  }

  private dispatchRoomEvent(roomId: string, event: RoomEvent) {
    if (event.targetId) {
      const target = this.roomSockets.get(roomId)?.get(event.targetId);
      if (target) {
        target.emit(event.type, event.payload);
      }
      return;
    }
    this.server.to(roomId).emit(event.type, event.payload);
  }

  private broadcastRoomUpdate(roomId: string) {
    const snapshot = this.game.getSnapshot(roomId);
    if (snapshot) this.server.to(roomId).emit('room:snapshot', snapshot);
  }

  private checkSocketRateLimit(
    socket: AuthedSocket,
    action: string,
    limit: number,
    windowMs: number,
  ): boolean {
    // Use playerId or sessionId instead of socket.id to prevent rate limit bypass via reconnect
    const identifier = socket.data.playerId || socket.data.sessionId || socket.id;
    const key = `${action}:${identifier}`;
    const now = Date.now();
    const bucket = this.rateLimits.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.rateLimits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    bucket.count++;
    if (bucket.count > limit) {
      socket.emit('error', 'RATE_LIMITED', `Too many ${action} events`);
      return false;
    }
    return true;
  }

  onModuleDestroy() {
    if (this.rateLimitCleanupInterval) {
      clearInterval(this.rateLimitCleanupInterval);
      this.rateLimitCleanupInterval = null;
    }
    for (const { timer } of this.disconnectTimers.values()) clearTimeout(timer);
    this.disconnectTimers.clear();
    this.rateLimits.clear();
    this.roomSockets.clear();
    this.activeMemberships.clear();
    this.joinAttempts.clear();
    this.joinAttemptStates.clear();
    this.joinAttemptTargets.clear();
    this.kickedSessions.clear();
  }
}
