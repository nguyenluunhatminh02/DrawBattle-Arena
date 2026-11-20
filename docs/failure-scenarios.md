# Failure scenarios

Scope: what actually happens today at commit `92b3e23`. "Gap" marks missing behaviour, not an implemented safeguard.

## 1. API process crashes or is restarted during a match

- **Trigger:** container restart, deploy, OOM.
- **Current behaviour:** all in-memory rooms, timers, strokes, scores, rate-limit buckets and socket rooms are lost. PostgreSQL still has `Room.status = PLAYING` and active `RoomPlayer` rows.
- **On next join:** gateway detects no in-memory snapshot, resets DB status to `WAITING`, emits `match:cancelled {reason:'SERVER_RESTART'}` to the joining socket, rebuilds in-memory players from DB, repairs host pointer, sends fresh snapshot.
- **Other clients:** keep stale UI until reconnect/resync; no broadcast cancellation is possible because sockets are gone.
- **Data loss:** the unfinished match is never persisted. No replay, scores or guesses.
- **Gap:** no health endpoint, no startup alert, no cross-client cancellation, no match resume.

## 2. Redis unavailable at boot

- **Current behaviour:** `RedisAdapterService` logs "Failed to connect to Redis" and continues in single-instance mode. The API still plays matches for locally connected sockets.
- **Impact:** with one API process, none for local broadcast. With multiple API processes, emits do not cross instances.
- **Gap:** no health status exposing `isEnabled()`; no alert on degraded mode.

## 3. Redis unavailable after successful boot

- **Current behaviour:** client `error` events are logged; the adapter remains configured. Socket.IO adapter behaviour depends on the client library's reconnection; no application-level fallback is triggered.
- **Gap:** no reconfiguration, no metric, no user-visible degradation.

## 4. PostgreSQL unavailable

- **Current behaviour:** `handleConnection` token validation queries fail → token rejected → socket disconnected. `room:join` throws → `JOIN_FAILED` (or a mapped code) to the client. `endMatch` write failure is caught and reported in `match:finished {persisted:false}`.
- **Fire-and-forget writes** (host transfer, room status resets, settings on empty room) log errors but are not retried.
- **Gap:** no circuit breaker, no queue for failed writes, no retry of a failed match persistence. A `persisted:false` match is lost from history/replay.

## 5. Client drops WebSocket briefly (< 15 s)

- **Current behaviour:** gateway marks player offline, removes socket mapping, starts a 15 s `disconnectTimer`; `room:snapshot` shows `isOnline:false`.
- **Reconnect:** socket.io client retries; on successful `connect` it emits `room:join` again. `joinRoom` returns the same `playerId` for an active row, the timer is cleared, `addPlayer` sets `isOnline=true`, private word/turn snapshot are re-sent, and a full room snapshot is broadcast.
- **All-correct grace:** if the 1.5 s auto-end timer is pending, a reconnect clears it and re-evaluates eligible guessers; a new timer with remaining turn time is armed if needed.
- **Gap:** if the auto-end timer has already fired, the turn is in REVEAL and cannot be rejoined into DRAWING; that is expected.

## 6. Client drops WebSocket longer than 15 s

- **Current behaviour:** `leaveRoom` sets `leftAt`, then in-memory player is removed, `room:playerLeft` and fresh snapshot are broadcast. The DB row remains (soft delete) and can be reactivated on a later join with the same identity.
- **Password rooms:** the password is checked before the reconnect early return, so an expired grace period cannot be exploited to skip it.
- **Mid-match:** if the room drops below the mode's minimum players, `endMatch` runs; if the departing player was the drawer, `abortCurrentTurn` runs.
- **Gap:** `leaveRoom` can throw (e.g., DB hiccup); error is logged but the timer still proceeds to remove the in-memory player. A DB row with `leftAt=null` may then keep occupying a slot.

## 7. Room full race

- **Current behaviour:** `joinRoom` runs as a `Serializable` transaction; capacity is checked there. Gateway also checks in-memory capacity in `addPlayer`; if it fails, it calls `leaveRoom` to release the just-created DB row and emits `ROOM_FULL`.
- **Gap:** in-process and DB capacity checks are two sources of truth; with multiple API instances (unsupported, see ADR-004) they can disagree.

## 8. Host disconnects or leaves

- **Current behaviour:** `removePlayer` picks the next player from the in-memory Map as host, emits `room:hostChanged`, and fire-and-forget updates `Room.hostPlayerId`. On rebuild after restart, the gateway repairs the host pointer from active DB players.
- **Gap:** if the fire-and-forget DB update fails, DB and memory disagree until a restart repair or another host change.

## 9. Kick target is offline

- **Current behaviour:** `banPlayer` resolves identities from the DB `RoomPlayer` row, so offline targets can still be banned. `kickedSessions` fast path is updated for online instances. Future joins check `RoomBan`.
- **Gap:** guest bans are session-scoped; a new guest session is a new identity.

## 10. Duplicate/concurrent challenge guesses

- **Current behaviour:** `ChallengeService.submitGuess` takes a PostgreSQL advisory transaction lock keyed by challenge id, then counts prior attempts and inserts the new one atomically. The 3-attempt cap cannot be exceeded by concurrency.
- **Gap:** the TTL check uses app time; a guess arriving just before expiry can be accepted even if cleanup has marked the challenge expired in another process.

## 11. Replay render fails or times out

- **Current behaviour:** render jobs are persisted in `render_jobs` (migration `20261123_durable_render_jobs_funnel_events`) with bounded attempts, leases and stale-job recovery; a process-local store is used only if that table is absent. Worker timeout is 60 s, rendering is capped at 3 concurrent jobs, and a 5-minute cron re-queues pending work. `queueRender` is throttled to 3/min per identity.
- **Gap:** no dead-letter queue and no alert; a deterministically failing job ends in `failed` after its retry budget is exhausted and needs manual intervention. GIF files live on the API container filesystem, so scaling/replacement loses them unless the volume is preserved.
- **Filesystem limitation:** GIFs are written to `public/replays/<replayId>.gif` on the API process's local disk (the `media_data` volume on a single Docker host). Render jobs are durable but the resulting files are not shared between API instances or rebuilt on another host, so a replay URL can 404 after a scale-out, redeploy to a different node, or volume loss even though `render_jobs` and `Replay.gifUrl` still say the render completed. Object storage plus a one-off re-render/rewrite of stale `gifUrl` rows is required for multi-host durability.

## 12. Rate-limit buckets grow unbounded / reset on restart

- **Current behaviour:** gateway cleans expired buckets every 5 minutes and removes buckets for a disconnecting socket/player; HTTP throttle buckets have no cleanup at all.
- **Gap:** HTTP buckets are never purged (memory growth over long uptime); socket buckets are per-process, so limits multiply with API replicas.

## 13. Stale room expiry

- **Current behaviour:** `CleanupService` runs every 5 minutes (10 s after boot) and deletes expired rooms with no matches, expires challenges, and deletes eligible guest sessions.
- **Gap:** a room with any match is never deleted by cleanup; orphaned `PLAYING` rooms after a crash rely on a join to reset status.

## 14. Profanity / abusive content

- **Current behaviour:** chat messages are rejected on profanity; wrong guesses are censored in chat broadcast; nicknames are validated at creation. Mutes are enforced in gateway handlers.
- **Gap:** correct guesses are not profanity-filtered (no text is broadcast for them, so no direct leak); private word and hint text come from the curated word list.
