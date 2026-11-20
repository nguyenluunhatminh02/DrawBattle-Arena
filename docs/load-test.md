# Load-test plan

Scope: plan and procedure as of commit `92b3e23`. The thresholds below are **proposed gates**, not measured SLOs — establish baselines before enforcing them. No formal load-test CI job exists today.

## 1. What exists today

`apps/web/socket-load.mjs` is a runnable Node harness using `socket.io-client`:

- Creates `LOAD_ROOMS` rooms (default 10) with `LOAD_PLAYERS` guest players each (default 4), in batches of 5 concurrent rooms.
- For each room: creates guest sessions via `POST /api/guest-sessions`, creates a room via `POST /api/rooms`, has every socket emit `room:join`, reads `room:snapshot`, marks non-hosts ready, starts a match, chooses the first word, emits one stroke chunk, has all guessers submit the correct word, and waits for `turn:revealed`.
- Reports JSON with `rooms`, `totalSockets`, `errors`, `elapsedMs`, and p50/p95 for join latency, guess acknowledgement and stroke propagation.

```bash
# From the repository root, with API running on 127.0.0.1:3001
LOAD_ROOMS=10 LOAD_PLAYERS=4 node apps/web/socket-load.mjs
```

Limitations of the harness: it stops after one turn; it does not close rooms cleanly (sockets close, but rooms remain in the DB until cleanup); it does not exercise reconnect, chat, profanity, kicks, match persistence at `endMatch`, replay rendering or HTTP admin endpoints. Numbers are per-run and not exported to a dashboard.

## 2. Test environment

- Use a deployment equivalent to `docker-compose.yml` (PostgreSQL 16, Redis 7, one API, one web) with `NODE_ENV=production` and realistic `JWT_SECRET`/`TRUST_PROXY`.
- Reset the DB or use a dedicated database between runs so expired rooms and guest rows do not skew results.
- Run load generation on a separate host/process from the API so client CPU does not distort measurements.
- Set `THROTTLE_MULT` explicitly; record its value with every result.
- Record API RSS, CPU, event-loop lag, PostgreSQL active connections and Redis pub/sub stats during every run.

## 3. Scenarios

### S1 — Baseline join and one turn (existing harness)

- Command as above; start at 10 rooms × 4 players (40 sockets), then 25 × 4 (100), then 50 × 4 (200).
- Measure: join p50/p95, guess ack p50/p95, stroke propagation p50/p95, error count, API RSS.
- Proposed gate: errors = 0, join p95 < 1 s, stroke propagation p95 < 200 ms, guess ack p95 < 500 ms at 100 sockets.

### S2 — Full match persistence

- Extend the harness: set room settings to `rounds: 1`, play every turn in `drawerOrder` to `match:finished`, and assert the payload has `persisted: true`.
- Query PostgreSQL afterwards to confirm one `Match` row with expected `Round`, `Turn`, `Guess`, `Score` and `Replay` counts.
- Measure: `match:finished` latency, p95 of the nested `match.create`, DB connection peak.
- Proposed gate: zero `persisted:false`, persist p95 < 2 s for 8-player rooms.

### S3 — Stroke storm

- One drawer emits the maximum allowed 30 chunks/s with 2000 points each for a full 60 s turn; all guessers receive `draw:chunk`.
- Verify: no `RATE_LIMITED` below 30/s, no `INVALID_PAYLOAD` for valid chunks, no socket disconnect, API memory stable after 5 turns.
- Measure: broadcast fan-out p50/p95 per extra player, dropped chunks, event-loop lag.
- Proposed gate: event-loop lag p95 < 100 ms, no invalid drops of well-formed chunks.

### S4 — Reconnect churn

- For 10 rooms × 8 players, disconnect and reconnect 50% of sockets within 15 s, then repeat after 20 s.
- Verify: same `playerId` for inside-grace reconnects; a new/reactivated row with `leftAt=null` after grace; `isOnline` flags converge to true; no duplicate players in `room:snapshot`; password rooms still require the password.
- Measure: reconnect-to-snapshot latency, count of `turn:restore` events delivered, auto-end grace cancellations.
- Proposed gate: no duplicate player ids, 100% of drawer reconnects receive `turn:yourWord`.

### S5 — Restart recovery

- Use `apps/web/socket-restart-e2e.mjs` phase1/phase2: start a match, restart the API, rejoin.
- Verify: `match:cancelled` with `SERVER_RESTART`, DB status `WAITING`, a second match can start and finish.
- Measure: time from process start to first successful join.
- Known gap to document, not a gate: only the first rejoining client gets the cancellation.

### S6 — HTTP abuse / throttle correctness

- Drive `POST /api/guest-sessions` (limit 10/min), `POST /api/rooms` (5/min), `POST /api/challenges/:id/guesses` (10/30 s) from multiple identities.
- Verify: `429` after the configured limit for a single identity; different identities have independent buckets; `TRUST_PROXY` set correctly yields distinct buckets behind the proxy.
- Proposed gate: no bucket sharing unrelated clients; no unbounded memory growth after 30 minutes (HTTP throttle buckets have no cleanup today — measure this).

### S7 — Redis degradation

- Run S1 with `REDIS_URL` unset, then with Redis stopped after boot.
- Verify: API stays up, local play works, logs show single-instance mode.
- Record: lack of a health signal as a known gap (see [observability](./observability.md)).

## 4. Execution procedure

1. Confirm baseline: `docker compose ps`, health checks green, `pnpm --filter api test` passes (if `node_modules` is available).
2. Record versions: `git rev-parse HEAD`, Node version, PostgreSQL/Redis versions.
3. Run S1 at each concurrency level; wait for cleanup to remove expired rooms before the next run.
4. Run S2–S7; capture JSON output to files outside the repo (e.g. `/tmp/drawbattle-load/`).
5. Plot p50/p95 series and compare against proposed gates.
6. Open an issue for every gate miss; update this document with measured baselines when they exist.

## 5. Interpretation notes

- Rooms are unbounded in memory; watch RSS growth across runs even if per-run latency looks fine.
- Because rate-limit buckets are process-local, results from multiple API replicas are not comparable to the single-instance baseline.
- With the room-owner lease unused (ADR-004), do not load-test multiple API replicas behind a load balancer as if they formed a supported cluster; results will reflect unsupported split-brain behaviour.
- The load harness closes sockets without `room:leave`, so 15 s disconnect timers and cleanup affect subsequent runs. Wait at least 20 s between scenarios or reset the database.
