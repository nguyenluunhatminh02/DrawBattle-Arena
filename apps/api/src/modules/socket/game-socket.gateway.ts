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
import { Logger } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { RoomService } from '../room/room.service';
import { GameStateService, RoomEvent } from '../game/game-state.service';
import { RedisAdapterService } from './redis-adapter.service';
import { validateStrokeCoordinates } from '@drawbattle/shared';
import type { StrokeChunk } from '@drawbattle/shared';
import { containsProfanity } from '../../common/profanity';

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
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();
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

  handleDisconnect(socket: AuthedSocket) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    const sessionId = socket.data.sessionId;

    for (const [key] of this.rateLimits) {
      if (key.endsWith(`:${playerId}`) || key.endsWith(`:${sessionId}`) || key.endsWith(`:${socket.id}`)) {
        this.rateLimits.delete(key);
      }
    }

    if (roomId && playerId) {
      const roomMap = this.roomSockets.get(roomId);
      const currentSocket = roomMap?.get(playerId);
      if (currentSocket && currentSocket.id !== socket.id) {
        return;
      }

      this.game.setPlayerOnline(roomId, playerId, false);
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
        if (latestMapNow?.has(playerId)) {
          return;
        }
        this.game.removePlayer(roomId, playerId);
        this.server.to(roomId).emit('room:playerLeft', playerId);
        this.broadcastRoomUpdate(roomId);
        this.disconnectTimers.delete(playerId);
        socket.data.roomId = undefined;
        socket.data.playerId = undefined;
      }, 15_000);
      this.disconnectTimers.set(playerId, timer);
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

      const joined = await this.roomService.joinRoom(
        roomCode,
        nickname,
        socket.data.identityType === 'guest' ? socket.data.sessionId! : null,
        socket.data.identityType === 'user' ? socket.data.userId! : null,
        typeof data.password === 'string' ? data.password : undefined,
      );
      socket.data.playerId = joined.playerId;
      socket.data.roomId = joined.roomId;
      socket.data.roomCode = roomCode;
      // Do not join the socket room until capacity is confirmed: on ROOM_FULL
      // the socket must not be an active room member.
      const existingTimer = this.disconnectTimers.get(joined.playerId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.disconnectTimers.delete(joined.playerId);
      }

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
      const message = err instanceof Error ? err.message : 'Join failed';
      const lower = message.toLowerCase();
      let code = 'JOIN_FAILED';
      if (lower.includes('password')) code = 'INVALID_PASSWORD';
      else if (lower.includes('full')) code = 'ROOM_FULL';
      else if (lower.includes('progress')) code = 'GAME_IN_PROGRESS';
      else if (lower.includes('expired')) code = 'ROOM_EXPIRED';
      else if (lower.includes('not found')) code = 'ROOM_NOT_FOUND';
      socket.emit('error', code, message);
    }
  }

  @SubscribeMessage('room:leave')
  async onRoomLeave(@ConnectedSocket() socket: AuthedSocket) {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !playerId || !this.isActiveMember(socket, roomId, playerId)) return;

    const timer = this.disconnectTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(playerId);
    }

    try {
      await this.roomService.leaveRoom(roomId, playerId);
    } catch (err) {
      this.logger.error('Failed to mark player left', err instanceof Error ? err.message : String(err));
    }

    this.game.removePlayer(roomId, playerId);

    const roomMap = this.roomSockets.get(roomId);
    if (roomMap) {
      roomMap.delete(playerId);
      if (roomMap.size === 0) {
        this.roomSockets.delete(roomId);
      }
    }
    socket.leave(roomId);
    this.server.to(roomId).emit('room:playerLeft', playerId);
    this.broadcastRoomUpdate(roomId);
    socket.emit('room:left');
    socket.data.roomId = undefined;
    socket.data.roomCode = undefined;
    socket.data.playerId = undefined;
  }

  @SubscribeMessage('room:ready')
  onReady(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() ready: boolean,
  ) {
    if (!socket.data.roomId || !socket.data.playerId) return;
    this.game.setReady(socket.data.roomId, socket.data.playerId, ready);
    this.broadcastRoomUpdate(socket.data.roomId);
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
        // Persist the ban before removal: resolve identities from the DB, not
        // the socket, so offline targets and token rotation cannot evade it.
        // Never remove the player first - a failed DB write would fail open.
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
        if (!this.game.kickPlayer(roomId, playerId, data.targetId)) {
          socket.emit('error', 'KICK_FAILED', 'Cannot kick player');
          break;
        }
        // Best-effort fast path only; joinRoom checks the DB authoritatively.
        const denylist = this.kickedSessions.get(roomId) ?? new Set<string>();
        if (banned.guestSessionId) denylist.add(banned.guestSessionId);
        if (banned.userId) denylist.add(banned.userId);
        if (banned.guestSessionId || banned.userId) {
          this.kickedSessions.set(roomId, denylist);
        }
        const timer = this.disconnectTimers.get(data.targetId);
        if (timer) {
          clearTimeout(timer);
          this.disconnectTimers.delete(data.targetId);
        }
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

  private isActiveMember(socket: AuthedSocket, roomId: string, playerId: string): boolean {
    if (!socket.rooms.has(roomId)) return false;
    const snapshot = this.game.getSnapshot(roomId);
    return !!snapshot?.players.some(p => p.id === playerId);
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
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.disconnectTimers.clear();
    this.rateLimits.clear();
    this.roomSockets.clear();
    this.kickedSessions.clear();
  }
}
