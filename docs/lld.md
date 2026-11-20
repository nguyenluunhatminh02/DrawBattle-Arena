# LLD — Low-Level Design

Scope: implementation-level walkthrough of the game path at commit `92b3e23`.

## 1. Module dependency shape

```
GameSocketGateway
 ├─ AuthService          -> PrismaService, JwtService
 ├─ RoomService          -> PrismaService
 ├─ GameStateService     -> WordService, PrismaService, FeatureFlagService
 └─ RedisAdapterService  -> Redis pub/sub clients (optional)

RoomRouterService        -> Redis client (setRedis never called; see HLD §4)
CleanupService           -> PrismaService (5-min interval)
ReplayWorker             -> PrismaService + worker_threads
```

Modules are declared in `apps/api/src/app.module.ts`; `socket.module.ts` provides the gateway and adapter. `GameStateService.registerSink(roomId, sink)` installs the gateway's `dispatchRoomEvent` as the sole output channel for game events — the game service never imports Socket.IO.

## 2. In-memory state model (`game-state.service.ts`)

```
rooms: Map<roomId, RoomState>
  RoomState
    roomId, hostId, settings, teams?
    players: Map<playerId, PlayerState>   // score, ready, online, muted, kicked, ...
    match: MatchState | null
      id, rounds, totalTurns, currentRound, drawerOrder[], currentDrawerIndex
      turn: TurnState | null
        id, drawerId, wordId, word, synonyms, phase, startedAt, endsAt,
        strokes[], guesses[], correctGuessers Set, firstCorrectId,
        wordOptions[], hintPhase, timer, hintTimers[], ended
      completedTurns[]                     // flushed once at endMatch
sinks:  Map<roomId, (event: RoomEvent) => void>
locks:  Map<roomId, Promise<void>>         // per-room FIFO chain
autoEndTimers: Map<roomId, Timeout>        // 1.5 s grace after all guessers correct
```

Gateway-side maps (`game-socket.gateway.ts`):

```
roomSockets:      Map<roomId, Map<playerId, Socket>>  // authoritative current socket per player
disconnectTimers: Map<playerId, Timeout>              // 15 s reconnect grace
kickedSessions:   Map<roomId, Set<identity>>          // fast-path denylist; DB bans authoritative
rateLimits:       Map<"action:playerId|sessionId|socketId", {count, resetAt}>
```

`isActiveMember(socket, roomId, playerId)` requires both `socket.rooms.has(roomId)` and a matching player in the in-memory snapshot. Every mutating handler checks it.

## 3. Concurrency model

- `withLock(roomId, fn)` chains async operations per room: each call waits for the previous chain segment; `startMatch`, `chooseWord` and `endMatch` use it. Guess/stroke/chat handlers are synchronous in-memory mutations — safe because Node runs them to completion without awaits.
- `RoomService.joinRoom` uses a PostgreSQL `Serializable` transaction (`maxWait 5 s`, `timeout 10 s`) and the `(roomId,userId)` / `(roomId,guestSessionId)` uniques to serialize capacity and reconnect decisions across processes. All other writes use Prisma defaults.
- Timers are plain `setTimeout`s: word-pick auto-select, turn end, two hints, reveal → next turn, 2 s inter-turn pause, 15 s disconnect grace, 1.5 s all-correct grace, 10 s cleanup start then 5-minute interval, 5-minute replay sweep. **All are process-local and lost on restart.**

## 4. Socket event contract

Event names and payload types live in `packages/shared/src/types/socket-events.ts`. Server-to-client events are emitted only through `GameStateService.emit` (`RoomEvent` with optional `targetId`) or the gateway's `broadcastRoomUpdate` / direct `socket.emit`.

| Direction | Events |
| --- | --- |
| Client → server | `room:join`, `room:leave`, `room:ready`, `match:start`, `match:rematch`, `turn:chooseWord`, `draw:strokeStart`, `draw:strokeChunk`, `draw:strokeEnd`, `draw:clear`, `draw:undo`, `guess:submit`, `chat:send`, `room:hostAction`, `room:updateSettings`, `state:resync` |
| Server → client | `room:snapshot`, `room:playerJoined`, `room:playerLeft`, `room:left`, `room:hostChanged`, `room:kicked`, `room:playerKicked`, `room:playerMuted`, `match:started`, `match:teams`, `match:cancelled`, `match:phaseChanged`, `turn:youAreDrawer`, `turn:publicState`, `turn:yourWord`, `turn:hint`, `turn:restore`, `draw:chunk`, `draw:reset`, `draw:undo`, `guess:accepted`, `guess:correct`, `guess:wrong`, `score:updated`, `turn:revealed`, `match:finished`, `chat:message`, `error` |

Important payload rules:

- `yourPlayerId` exists only in the personalized `room:snapshot` emitted on join/resync. `broadcastRoomUpdate` deliberately omits it; the client preserves its existing id (`apps/web/src/app/room/[code]/page.tsx`).
- `room:snapshot.settings` strips `password` and `passwordHash`; `hasPassword` is a boolean.
- Targeted events use `RoomEvent.targetId`; the gateway looks up `roomSockets.get(roomId).get(targetId)` and emits only there (word, kick, drawer options, guess acceptance).
- Errors use `socket.emit('error', code, message)`; codes include `ROOM_FULL`, `INVALID_PASSWORD`, `KICKED`, `NOT_HOST`, `NOT_DRAWER`, `MUTED`, `PROFANITY`, `RATE_LIMITED`, `INVALID_PAYLOAD`.

## 5. Turn state machine

```
WAITING --host match:start--> WORD_PICK --drawer chooseWord (or auto after 10 s)--> DRAWING
DRAWING --timer / all guessers correct--> REVEAL (5 s) --> NEXT_TURN (2 s) --> WORD_PICK
any phase --last turn / too few players--> endMatch --> WAITING
```

- `startMatch` shuffles eligible players into `drawerOrder`, resets scores, resolves feature flags `classic_turn_duration` and `classic_hints` for CLASSIC mode, initializes TEAM divisions, persists `Room.status = PLAYING` fire-and-forget, emits `match:started`, then starts word pick under the room lock.
- `chooseWord` clears the auto-select timer, loads the word from DB, increments usage, then enters DRAWING. The drawer receives `turn:yourWord` privately; everyone else receives a masked hint at 40% and 70% of the turn duration when hints are enabled.
- `submitStroke` validates `turnId`, drawer role, payload size, point count and per-stroke sequence; chunks are appended in memory and re-emitted to the room as `draw:chunk`.
- `submitGuess` enforces phase, drawer/teammate exclusion, per-player guess interval and per-turn cap. Correct guesses score `min(60 + floor(100*remaining/duration) + 20 if first, 160)`; drawer scores `min(20*correctGuessers, 100)`.
- `endTurn` sets `REVEAL`, awards drawer points, pushes a `CompletedTurn` (strokes + guesses) into the match, then schedules `transitionToNextTurn`.
- `endMatch` uses the room lock, resets ready/per-turn flags, resets `Room.status` to `WAITING` fire-and-forget, and **synchronously awaits one Prisma `match.create` with nested rounds/turns/replays/guesses/scores**. `match:finished` includes `persisted: boolean`, so clients can see a write failure (`apps/web` shows it in the result screen).

## 6. Persistence rules and consistency boundaries

| Operation | Durable write | Timing |
| --- | --- | --- |
| Room create | `Room` + host `RoomPlayer` + host pointer | One Prisma `$transaction`. |
| Join | `RoomPlayer` create/reactivate, ban check, password check, capacity | One `Serializable` transaction. |
| Disconnect | `leaveRoom` sets `leftAt` after 15 s; slot is removed from memory only after that write completes | Deliberate ordering prevents password-free rejoin and permanent slot occupation. |
| Kick | `RoomBan` upserts first, then `leaveRoom`, then socket eviction | DB is authoritative for rejoin denial; in-memory denylist is a fast path. |
| Host change | `Room.hostPlayerId` update | Fire-and-forget `.catch(log)` on transfer or last-player leave. |
| Match result | Full nested `Match` graph | One awaited write at `endMatch`; failure is reported in the socket payload, not retried. |
| Settings | `Room.settings` JSON update | Awaited, errors logged; in-memory settings updated before the DB call. |
| Replay GIF | `Replay.gifUrl`, `render_jobs` | Jobs are queued and claimed durably in `render_jobs` (migration `20261123_durable_render_jobs_funnel_events`), with attempt counters, leases and stale recovery; the worker writes the file then updates `Replay.gifUrl`. The in-memory store is only a fallback when `render_jobs` is missing. |

**Consistency gap:** if the API process dies mid-match, the in-memory match (including strokes and scores) is gone, and `match:cancelled` can only be sent to the *first* player who rejoins and finds no in-memory snapshot (gateway join path). There is no durable "match was in progress" marker that all clients receive. See [failure scenarios](./failure-scenarios.md) and [ADR-003](./adr/003-match-recovery-restart-cancel.md).

## 7. Validation and abuse controls

- Stroke chunks: 30/s per identity, ≤2000 points per chunk, coordinates normalized to [0,1], color `#RRGGBB`, width 1–20, ≤64 KiB serialized payload, ≤500 strokes/turn, monotonic `seq` per stroke.
- Guesses: ≤100 chars, 5/s socket bucket, 500 ms per-player interval, ≤20/turn, normalized NFC/lowercase/whitespace comparison against canonical + synonyms.
- Chat: ≤200 chars, 5 per 5 s socket bucket, 1 s per-player interval, profanity rejection.
- HTTP: `@Throttle` per handler with identity-first keys; `TRUST_PROXY` must be configured correctly or all clients behind a proxy collapse into one bucket.
- Room code creation retries up to 10 collisions; codes use an unambiguous 32-character alphabet.

**Gap:** rate-limit buckets live in each API process's memory. With more than one API instance, effective limits multiply by instance count. Socket rooms also live in each process; only the Redis adapter's broadcast layer is shared.
