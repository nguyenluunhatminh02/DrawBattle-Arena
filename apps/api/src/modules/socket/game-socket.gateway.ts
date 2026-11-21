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
import { GameStateService, RoomEvent } from '../game/game-state.service';
import { RedisAdapterService } from './redis-adapter.service';
import { validateStrokeCoordinates } from '@drawbattle/shared';
import type { StrokeChunk } from '@drawbattle/shared';
import { containsProfanity } from '../../common/profanity';

interface DisconnectTimer {
  timer: NodeJS.Timeout;
  roomId: string;
  playerId: string;
  socketId: string;
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
   * would cancel the live socket's grace period.
   */
  private clearDisconnectTimer(
    roomId: string,
    playerId: string,
    socketId?: string,
  ): boolean {
    const current = this.disconnectTimers.get(playerId);
    if (!current || current.roomId !== roomId || current.playerId !== playerId) {
      return false;
    }
    if (socketId !== undefined && current.socketId !== socketId) {
      return false;
    }
    clearTimeout(current.timer);
    this.disconnectTimers.delete(playerId);
    return true;
  }

  /**
   * A socket is a member of at most one game room at a time. Every action
   * handler relies on this exact socket-id match so a superseded socket can
   * never act on behalf of the player whose identity it used to carry.
   */
  private isActiveMember(socket: AuthedSocket, roomId: string, playerId: string): boolean {
    if (socket.data.roomId !== roomId || socket.data.playerId !== playerId) return false;
    if (!socket.rooms.has(roomId)) return false;
    return this.roomSockets.get(roomId)?.get(playerId)?.id === socket.id;
  }

  /**
   * Revoke a superseded socket without touching game state or the DB row:
   * the new socket takes over the same player slot. Removing the old socket
   * from roomSockets and clearing its data makes every guarded handler reject
   * it, and cancelling its grace timer prevents a stale disconnect from
   * evicting the replacement.
   */
  private revokeReplacedSocket(oldSocket: AuthedSocket, roomId: string, playerId: string): void {
    this.clearDisconnectTimer(roomId, playerId, oldSocket.id);
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
   * cannot keep the room full or accept a password-free rejoin.
   */
  private async leaveCurrentRoom(socket: AuthedSocket): Promise<void> {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;

    // Persist the departure before releasing in-memory state so a rejected
    // write aborts the switch and leaves the old membership intact.
    try {
      await this.roomService.leaveRoom(roomId, playerId);
    } catch (err) {
      this.logger.error(
        'Failed to mark player left on room switch',
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }

    this.clearDisconnectTimer(roomId, playerId, socket.id);
    this.game.removePlayer(roomId, playerId);
    const roomMap = this.roomSockets.get(roomId);
    roomMap?.delete(playerId);
    if (roomMap?.size === 0) this.roomSockets.delete(roomId);
    socket.leave(roomId);
    this.server.to(roomId).emit('room:playerLeft', playerId);
    this.broadcastRoomUpdate(roomId);
    socket.emit('room:left');
    socket.data.roomId = undefined;
    socket.data.roomCode = undefined;
    socket.data.playerId = undefined;
  }

  handleDisconnect(socket: AuthedSocket) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    const sessionId = socket.data.sessionId;

    if (roomId && playerId) {
      const roomMap = this.roomSockets.get(roomId);
      const currentSocket = roomMap?.get(playerId);
      const pendingTimer = this.disconnectTimers.get(playerId);
      // Only the socket still registered as this player's active member may
      // tear down membership. A replaced (or already evicted) socket must not
      // mark the live socket offline, cancel its grace timer or delete it from
      // roomSockets. This also gates the shared rate-limit buckets below.
      if (!currentSocket || currentSocket.id !== socket.id) return;
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
      this.game.setPlayerOnline(roomId, playerId, false);
      const roomMap = this.roomSockets.get(roomId);
      if (roomMap) {
        roomMap.delete(playerId);
        if (roomMap.size === 0) {
          this.roomSockets.delete(roomId);
        }
      }
      this.broadcastRoomUpdate(roomId);
      const timer = setTimeout(async () => {
        const latestMap = this.roomSockets.get(roomId);
        // Persist the departure before freeing the slot. Without this the
        // player keeps leftAt=null in DB, occupies a slot forever and can
        // rejoin a password-protected room without supplying the password.
        try {
          await this.roomService.leaveRoom(roomId, playerId);
        } catch (err) {
          this.logger.error(
            'Failed to persist player departure',
            err instanceof Error ? err.message : String(err),
          );
        }
        // Re-check after the await: a reconnect may have installed a new
        // socket for this playerId while leaveRoom was in flight.
        const latestMapNow = this.roomSockets.get(roomId);
        if (
          latestMapNow?.has(playerId) ||
          this.disconnectTimers.get(playerId) !== current
        ) {
          return;
        }
        this.game.removePlayer(roomId, playerId);
        this.server.to(roomId).emit('room:playerLeft', playerId);
        this.broadcastRoomUpdate(roomId);
        if (current === this.disconnectTimers.get(playerId)) {
          this.disconnectTimers.delete(playerId);
        }
        socket.data.roomId = undefined;
        socket.data.playerId = undefined;
      }, 15_000);
      // A newer socket for this player supersedes any older disconnect timer.
      this.clearDisconnectTimer(roomId, playerId);
      const current: DisconnectTimer = {
        timer,
        roomId,
        playerId,
        socketId: socket.id,
      };
      this.disconnectTimers.set(playerId, current);
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
      if (socket.data.roomId && socket.data.roomId !== room.id) {
        try {
          await this.leaveCurrentRoom(socket);
        } catch (err) {
          this.logger.error(
            'Room switch aborted: could not leave previous room',
            err instanceof Error ? err.message : String(err),
          );
          socket.emit('error', 'SWITCH_FAILED', 'Could not leave the previous room');
          return;
        }
      }

      const joined = await this.roomService.joinRoom(
        roomCode,
        nickname,
        socket.data.identityType === 'guest' ? socket.data.sessionId! : null,
        socket.data.identityType === 'user' ? socket.data.userId! : null,
        typeof data.password === 'string' ? data.password : undefined,
      );

      // When the same identity reconnects with a new socket, revoke the old
      // socket rather than leaving two sockets able to act for one player.
      // The player slot and DB row stay intact; the new socket takes over.
      const existingSocket = this.roomSockets.get(joined.roomId)?.get(joined.playerId);
      if (existingSocket && existingSocket.id !== socket.id) {
        this.revokeReplacedSocket(existingSocket, joined.roomId, joined.playerId);
      }

      socket.data.playerId = joined.playerId;
      socket.data.roomId = joined.roomId;
      socket.data.roomCode = roomCode;
      // Do not join the socket room until capacity is confirmed: on ROOM_FULL
      // the socket must not be an active room member.
      // The timer belongs to this player's reconnect: clear it only after
      // joinRoom confirms the identity that owns the slot.
      this.clearDisconnectTimer(joined.roomId, joined.playerId);

      const existingSnapshot = this.game.getSnapshot(joined.roomId);
      if (!existingSnapshot) {
        const dbRoom = await this.roomService.getRoomById(joined.roomId);
        if (dbRoom.status === 'PLAYING') {
          await this.roomService.resetRoomStatus(joined.roomId);
          socket.emit('match:cancelled', { reason: 'SERVER_RESTART' });
        }
        const activePlayers = dbRoom.players;
        const hostId =
          dbRoom.hostPlayerId && activePlayers.some(p => p.id === dbRoom.hostPlayerId)
            ? dbRoom.hostPlayerId
            : joined.playerId;
        if (hostId !== dbRoom.hostPlayerId) {
          await this.roomService.updateHost(joined.roomId, hostId);
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
        // joinRoom already persisted a DB row (or reactivated a soft-deleted
        // one), so release that slot before reporting ROOM_FULL; otherwise the
        // abandoned row keeps the room full forever.
        try {
          await this.roomService.leaveRoom(joined.roomId, joined.playerId);
        } catch (err) {
          this.logger.error(
            'Failed to roll back full-room join',
            err instanceof Error ? err.message : String(err),
          );
        }
        socket.data.playerId = undefined;
        socket.data.roomId = undefined;
        socket.data.roomCode = undefined;
        socket.emit('error', 'ROOM_FULL', 'Room is full');
        return;
      }

      socket.join(joined.roomId);
      this.game.registerSink(joined.roomId, (event: RoomEvent) => {
        this.dispatchRoomEvent(joined.roomId, event);
      });

      let map = this.roomSockets.get(joined.roomId);
      if (!map) {
        map = new Map();
        this.roomSockets.set(joined.roomId, map);
      }
      map.set(joined.playerId, socket);

      const snapshot = this.game.getSnapshot(joined.roomId)!;
      socket.emit('room:snapshot', {
        ...snapshot,
        code: room.code,
        yourPlayerId: joined.playerId,
      });
      this.server.to(joined.roomId).emit('room:playerJoined', {
        id: joined.playerId,
        nickname,
        isHost: joinedPlayer.isHost,
        isReady: joinedPlayer.isReady,
        isOnline: joinedPlayer.isOnline,
        score: joinedPlayer.score,
      });
      // Other clients need the authoritative snapshot; incremental
      // room:playerJoined alone can leave stale ready flags on reconnect.
      // Broadcasts must not carry yourPlayerId, which is per-socket.
      this.broadcastRoomUpdate(joined.roomId);

      const turn = this.game.getTurnSnapshot(joined.roomId);
      if (turn) {
        socket.emit('turn:restore', turn);
        const word = this.game.getDrawerWord(joined.roomId, joined.playerId);
        if (word) socket.emit('turn:yourWord', { word });
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
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;
    if (typeof ready !== 'boolean') {
      socket.emit('error', 'INVALID_PAYLOAD', 'Invalid ready state');
      return;
    }
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
        // The ban is durable, so it is now safe to remove the player from the
        // in-memory room. This also emits room:playerKicked to the target.
        this.game.kickPlayer(roomId, playerId, data.targetId);
        this.clearDisconnectTimer(roomId, data.targetId);
        this.roomSockets.get(roomId)?.delete(data.targetId);
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
    const ok = await this.game.updateSettings(roomId, playerId, data ?? {});
    if (!ok) {
      socket.emit('error', 'SETTINGS_FAILED', 'Cannot update settings during a match');
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
    this.kickedSessions.clear();
  }
}
