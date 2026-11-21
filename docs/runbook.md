# Runbook — DrawBattle operations

Scope: procedures valid at commit `92b3e23`. Commands assume `docker compose` from the repository root and `psql`/`redis-cli` available where noted. Every destructive command is marked; verify before running.

## 0. Preflight

```bash
docker compose ps                     # postgres, redis, api, web expected
docker compose logs --tail=100 api   # look for Redis/DB errors, JWT_SECRET fatal
psql "$DATABASE_URL" -c 'SELECT 1;'   # DB reachability
redis-cli -p 6390 ping                # expected PONG (compose host port)
```

There is **no API health endpoint** today; a successful `GET /api/rooms/<CODE>` (even a 404 for an unknown code) is the closest liveness probe. Web listens on 3002, API on 3001.

## 1. API restart (planned deploy)

1. Announce a short maintenance window: **all in-progress matches will be cancelled** ([ADR-003](./adr/003-match-recovery-restart-cancel.md)).
2. `docker compose restart api`.
3. Watch logs for "API server running on http://localhost:3001".
4. Verify a test room join + match start using `apps/web/socket-restart-e2e.mjs` phase1, then restart and phase2 (if this is a restart drill).
5. Check for stale `PLAYING` rooms (see §2).

## 2. Stale `PLAYING` room after crash

Symptom: DB says `Room.status='PLAYING'` but no live match exists; clients report a frozen game.

```sql
-- Inspect
SELECT id, code, status, "expiresAt" FROM rooms WHERE status = 'PLAYING';

-- Verify no API process currently holds the room (single-instance deployment):
docker compose logs --since=5m api | grep '<code>'
```

Resolution: ask a player to rejoin with the correct token/password. The join path resets status to `WAITING`, emits `match:cancelled` to that socket and rebuilds in-memory players. It does **not** notify other clients — instruct them to refresh the room page. If no player can rejoin:

```sql
-- DESTRUCTIVE: only when no live players remain and the match was already lost
UPDATE rooms SET status = 'WAITING', host_player_id = NULL
WHERE id = '<room-id>' AND status = 'PLAYING';
```

Before running that SQL, confirm no active sockets: in-memory state is invisible to SQL, so coordinate with users first. On a single API instance, `docker compose restart api` is the safer way to clear stale memory before updating rows.

## 3. Redis down

Symptoms: logs show "Failed to connect to Redis" or repeated "Redis Pub Client Error"; with multiple API instances, players see only local broadcasts.

1. `docker compose restart redis`; confirm `redis-cli -p 6390 ping` returns PONG.
2. `docker compose restart api` — the adapter is installed only at boot (`afterInit`), so a restart is required to re-enable cross-instance fan-out.
3. Verify log line "Socket.IO Redis adapter configured".
4. If Redis cannot be restored, the API still works for a single instance. Record the degradation; there is no health flag today.

## 4. PostgreSQL down / match persistence failed

Symptoms: joins fail with `JOIN_FAILED`; logs show "Failed to persist match <id>"; `match:finished {persisted:false}` in clients.

1. `docker compose restart postgres`; confirm `pg_isready` health check passes.
2. `docker compose restart api` if Prisma clients are in a broken state (check logs first).
3. Identify lost results: search API logs for `Failed to persist match` and collect match ids. Those matches are **not retried** — no automatic repair exists.
4. For affected users, explain the lost result; do not fabricate score entries. A manual backfill would require reconstructing strokes/guesses from logs, which are not logged in full.
5. Check connection pressure: `SELECT count(*) FROM pg_stat_activity WHERE datname='drawbattle';`

## 5. Players stuck / duplicate in room snapshot

Symptoms: `room:snapshot` shows duplicate players, a disconnected player remains `isOnline:true`, or a kicked player reappears.

1. Confirm which API instance serves the room (single instance in the shipped compose file).
2. Check `room_players` rows for the room:
   ```sql
   SELECT id, user_id, guest_session_id, nickname_snapshot, "leftAt"
   FROM room_players WHERE room_id = '<room-id>' ORDER BY joined_at;
   ```
3. If duplicates are from a reconnect race (two active rows for different identities with the same nickname), they are legitimate distinct players; verify with the users.
4. A kicked player reappearing means a `RoomBan` row is missing. Verify:
   ```sql
   SELECT * FROM room_bans WHERE room_id = '<room-id>';
   ```
   If missing, the kick did not complete durability; do not manually insert bans without verifying the moderation context.
5. Restarting the API clears in-memory state and rebuilds from DB active players; use it when memory and DB have diverged.

## 6. Replay backlog

Symptoms: `GET /api/replays/stats` shows many pending GIFs; `gifUrl` stays null.

1. Check API logs for "Queued render", "Max concurrent renders", "Worker timeout", "Failed to render".
2. Confirm `gif-worker.js` exists in the built output (log says "gif-worker.js not found at ..." otherwise → rebuild API image).
3. Render jobs are durable in `render_jobs` (migration `20261123_durable_render_jobs_funnel_events`); a restart requeues stale leases and consumes one attempt from the original budget per recovery. Rendering is capped at 3 concurrent jobs with a 60 s timeout and a 1-minute cron sweep; wait one sweep before escalating.
4. Inspect queue state: `SELECT state, count(*) FROM render_jobs GROUP BY state;`. A fallback in-memory store is used only if the table is missing (check the startup warning).
5. Check the persistent private GIF volume: `docker compose exec api ls -la /app/apps/api/private-replays`. Legacy `public/replays` files are migration-only and removed at startup.
6. A pointer with no file is rebuilt by reconciliation only while the job's original attempt budget remains; exhausted jobs stay terminal. A deterministically failing job ends in `failed` after its budget is exhausted — there is no dead-letter queue or alert. Read `error` from `render_jobs`; do not delete rows unless the replay is known bad.

## 7. Rate-limit complaints

1. Check `TRUST_PROXY`: compose defaults to `0`. Behind a proxy/tunnel it must be the number of trusted hops, otherwise all clients share one HTTP bucket.
2. Socket buckets use `playerId`/`sessionId`, not `socket.id`; a reconnect does not reset them.
3. `THROTTLE_MULT` multiplies HTTP limits; verify it is not set unintentionally.
4. There is no admin override. Wait for the window (60 s for most endpoints) or restart the API to clear in-memory buckets (both HTTP and socket buckets are process-local).

## 8. Cleanup / disk growth

`CleanupService` runs every 5 minutes: deletes rooms past `expiresAt` with no matches, expires challenges, deletes eligible guest sessions. It never deletes rooms with matches. Replay GIFs are only removed by `ReplayWorker.cleanupOldReplays(30)` — check whether that method is called anywhere before assuming automatic GIF cleanup.

```bash
docker compose exec api du -sh /app/apps/api/private-replays
```

## 9. Useful SQL

```sql
-- Active rooms and player counts
SELECT r.code, r.status, count(rp.id) FILTER (WHERE rp."leftAt" IS NULL) AS active_players
FROM rooms r LEFT JOIN room_players rp ON rp.room_id = r.id
GROUP BY r.id, r.code, r.status
HAVING count(rp.id) FILTER (WHERE rp."leftAt" IS NULL) > 0
ORDER BY active_players DESC;

-- Pending replays and durable render jobs
SELECT count(*) FROM replays WHERE gif_url IS NULL;
SELECT state, count(*) FROM render_jobs GROUP BY state;

-- Recent finished matches and persistence evidence
SELECT id, room_id, status, ended_at FROM matches ORDER BY started_at DESC LIMIT 20;
```

## 10. Escalation checklist

Include in every incident report: `git rev-parse HEAD`, API logs for the relevant window, room code (never passwords/tokens), affected player count, `match:cancelled` reasons observed, DB status of affected rooms, and whether Redis was healthy. See [observability](./observability.md) for the instrumentation backlog that would make these steps faster.
