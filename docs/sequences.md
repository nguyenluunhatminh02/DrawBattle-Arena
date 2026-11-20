# Sequence diagrams

Scope: current behaviour at commit `92b3e23`. Diagrams use Mermaid; `S` is the joining/reconnecting socket, `G` the gateway, `R` RoomService, `M` GameStateService, `DB` PostgreSQL.

## 1. Join a room

```mermaid
sequenceDiagram
  participant C as Client (room page)
  participant G as GameSocketGateway
  participant A as AuthService
  participant R as RoomService
  participant M as GameStateService
  participant DB as PostgreSQL

  C->>G: connect /game {auth.token}
  G->>A: validateGuestToken(token) then validateUserToken(token)
  A->>DB: find guest session / user
  A-->>G: sessionId, userId, verified nickname
  Note over G: socket.data identity set; no socket.io room yet
  C->>G: room:join {roomCode, password?}
  G->>G: ignore client nickname; uppercase code
  G->>R: getRoomInfo(code)
  R->>DB: room by code + active players
  R-->>G: room.id, hasPassword, status
  G->>G: check kickedSessions[room.id] fast path
  G->>R: joinRoom(code, nickname, guestSessionId|userId, password)
  R->>DB: Serializable txn: ban check, password check,<br/>existing active/reconnect, status, capacity, create/reactivate RoomPlayer
  R-->>G: {roomId, playerId}
  G->>G: clear pending disconnectTimer for playerId
  alt no in-memory snapshot (fresh process or first join)
    G->>R: getRoomById(roomId)
    R->>DB: room + active players
    G->>R: resetRoomStatus / updateHost if needed
    G->>M: initRoom(roomId, hostId, hostNickname, settings)
    loop each active DB player
      G->>M: addPlayer(roomId, playerId, nicknameSnapshot)
    end
  end
  G->>M: addPlayer(roomId, playerId, nickname)
  alt in-memory room full
    G->>R: leaveRoom(roomId, playerId) rollback
    G-->>C: error ROOM_FULL
  else joined
    G->>G: socket.join(roomId); roomSockets[roomId][playerId] = socket
    G->>M: registerSink(roomId, dispatchRoomEvent)
    M-->>C: room:snapshot {..., yourPlayerId} (personalized)
    G-->>C: room:playerJoined {player info}
    G-->>All: room:snapshot (broadcast, no yourPlayerId)
    opt match in progress
      M-->>C: turn:restore {turnId, phase, endsAt, strokes}
      M-->>C: turn:yourWord (drawer only)
    end
  end
```

Failure branches (all emitted as `error` with a code): invalid token → `UNAUTHORIZED`; missing code → `INVALID_PAYLOAD`; bad password → `INVALID_PASSWORD`; full → `ROOM_FULL`; in-progress for a genuinely new player → `GAME_IN_PROGRESS`; expired → `ROOM_EXPIRED`; unknown → `ROOM_NOT_FOUND`; banned → `KICKED`.

## 2. Turn lifecycle

```mermaid
sequenceDiagram
  participant H as Host socket
  participant D as Drawer socket
  participant P as Guessers
  participant G as Gateway
  participant M as GameStateService
  participant W as WordService/DB

  H->>G: match:start
  G->>M: canStartMatch(roomId, hostId)
  Note over M: min players met, non-hosts ready, no active match
  G->>M: startMatch (room lock)
  M->>W: pick 3 words; resolve feature flags
  M->>DB: room.status = PLAYING (fire-and-forget)
  M-->>All: match:started {matchId, round, drawerOrder}
  M-->>D: turn:youAreDrawer {turnId, words, timeLimit}
  M-->>All: turn:publicState {turnId, drawerId}
  Note over M: 10 s auto-select timer
  D->>G: turn:chooseWord(wordId)
  G->>M: chooseWord (room lock)
  M->>W: getWordById + incrementUsage
  M-->>D: turn:yourWord
  M-->>All: match:phaseChanged {DRAWING, endsAt}
  loop drawing
    D->>G: draw:strokeChunk {turnId, strokeId, seq, points,...}
    G->>G: validate shape, coords, size, 30/s bucket
    G->>M: submitStroke
    M-->>All: draw:chunk
  end
  loop guessing
    P->>G: guess:submit(text)
    G->>M: submitGuess (rate limits, teammate/drawer exclusion)
    alt correct
      M-->>All: guess:correct {playerId, score}
      M-->>All: score:updated
      opt all eligible guessers correct
        Note over M: 1.5 s grace, cancellable by reconnect
      end
    else wrong
      M-->>S: guess:wrong
      M-->>All: chat:message {isGuess:true, censored text}
    end
  end
  Note over M: turn timer expires or all-correct grace ends
  M->>M: endTurn
  M-->>All: turn:revealed {word, correctGuessers, drawerScore}
  M-->>All: score:updated
  Note over M: 5 s reveal, then 2 s NEXT_TURN pause
  M->>M: transitionToNextTurn -> startWordPickPhase
```

## 3. Reconnect after a dropped socket

```mermaid
sequenceDiagram
  participant C as Client
  participant G as Gateway
  participant R as RoomService
  participant M as GameStateService

  Note over G: previous socket disconnect:<br/>setPlayerOnline(false), delete roomSockets entry,<br/>start 15 s disconnectTimer
  C->>C: socket.io auto-reconnect (1 s delay, ≤10 attempts)
  C->>G: connect + room:join {same token, roomCode, password?}
  G->>R: joinRoom with same identity
  R->>DB: existing row with leftAt=null -> return same playerId<br/>(password re-checked first)
  G->>G: clearTimeout(disconnectTimer[playerId])
  G->>M: addPlayer sees existing playerId -> isOnline=true
  opt all-correct auto-end timer pending
    M->>M: clear 1.5 s timer; recompute eligible guessers;<br/>re-arm with remaining turn time if needed
  end
  G->>M: snapshot, turn:restore, private turn:yourWord
  G-->>All: room:snapshot (authoritative ready/online flags)
  Note over G: if reconnect arrives after the 15 s timer:<br/>leaveRoom has set leftAt, row is reactivated<br/>and a fresh in-memory player is added
```

The client also has a safety net: if no snapshot arrives 1.5 s after join it emits `state:resync`, which re-sends `room:snapshot`, `turn:restore` and the private word.

## 4. Host kick

```mermaid
sequenceDiagram
  participant H as Host
  participant G as Gateway
  participant M as GameStateService
  participant R as RoomService
  participant DB as PostgreSQL
  participant T as Target socket

  H->>G: room:hostAction {action:'kick', targetId}
  G->>M: kickPlayer (host check + target exists)
  M-->>T: room:playerKicked (targeted)
  G->>R: banPlayer(roomId, targetId)
  R->>DB: find RoomPlayer identities; upsert RoomBan rows
  R-->>G: {userId, guestSessionId}
  G->>G: add identities to kickedSessions[roomId] fast-path
  G->>G: evict target socket from roomSockets; emit room:kicked
  G->>R: leaveRoom (leftAt)
  G->>M: removePlayer -> host transfer / match abort if needed
  G-->>All: room:snapshot
  Note over DB: future joins check RoomBan first, so kicks<br/>survive process restarts and socket rotation
```

If `banPlayer` fails, the gateway emits `KICK_FAILED` and does not remove the player from in-memory state (the authorization check succeeded but durability did not).

## 5. API restart during a match

```mermaid
sequenceDiagram
  participant C1 as First rejoining client
  participant G as New API process
  participant R as RoomService
  participant M as GameStateService (empty)
  participant C2 as Other clients

  Note over G: process restarted; all Maps and timers empty.<br/>DB still has Room.status=PLAYING and active RoomPlayers.
  C1->>G: connect + room:join
  G->>R: joinRoom (existing active row returned; password checked)
  G->>M: getSnapshot(roomId) -> null
  G->>R: getRoomById(roomId) -> status PLAYING
  G->>R: resetRoomStatus(roomId)
  G-->>C1: match:cancelled {reason:'SERVER_RESTART'}
  G->>M: initRoom from DB players; repair host pointer; add players
  G-->>C1: room:snapshot {status:WAITING, yourPlayerId}
  Note over C2: they keep their old UI until they emit<br/>state:resync / reconnect; no broadcast cancellation exists
```

This path is exercised by `apps/web/socket-restart-e2e.mjs` (phase1 starts a match, phase2 rejoins after restart, verifies `match:cancelled` with `SERVER_RESTART` and a successful new match).

## 6. Challenge (async, no socket)

```mermaid
sequenceDiagram
  participant B as Browser
  participant API as REST API
  participant DB as PostgreSQL
  participant W as ReplayWorker

  B->>API: POST /api/challenges (optional auth)
  API->>DB: pick word, create Challenge (24 h TTL)
  API-->>B: challengeId, word (creator only), 15 s draw time
  B->>API: POST /api/challenges/:id/finalize {strokes, durationMs}
  API->>DB: creator identity check + Replay create + challenge.replayId
  B->>API: POST /api/replays/:id/render (throttled 3/min)
  API->>W: queue worker (max 3 concurrent, 60 s timeout)
  W->>W: render 640x400 GIF at 10 fps to public/replays
  W->>DB: replay.gifUrl = /replays/<id>.gif
  Solver->>API: POST /api/challenges/:id/guesses {answer}
  API->>DB: pg_advisory_xact_lock(challengeId); count attempts, TTL, replay present
  alt correct or out of attempts
    API-->>S: answer revealed, remainingAttempts
  else wrong with attempts left
    API-->>S: correct:false, remainingAttempts
  end
```

The advisory lock closes the concurrent-attempt race; the TTL check still depends on application time, and cleanup marks expired challenges every 5 minutes (`CleanupService`).
