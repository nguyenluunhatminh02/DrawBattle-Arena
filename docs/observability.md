# Observability plan

Scope: separates **instrumentation that exists today** (commit `92b3e23`) from a **proposed plan**. Nothing in the "Proposed" section is implemented.

## 1. What exists today

### Application logs (`@nestjs/common` Logger)

| Source | Events logged | Level |
| --- | --- | --- |
| `main.ts` | startup port, fatal `JWT_SECRET` misconfiguration (uses `console.error`, exits 1) | log/error |
| `GameSocketGateway` | failed departure persistence, failed full-room rollback, failed kick ban persistence, failed kick leave, failed settings failure note is only emitted to socket | error |
| `GameStateService` | match persisted (`matchId`, score count, replay count), failed match persist, failed settings persist, failed host transfer, failed empty-room reset, start failure | log/error |
| `RedisAdapterService` | no `REDIS_URL` (single-instance), pub/sub errors, adapter connected/configured, failed connect, unsupported server object | warn/log/error |
| `RoomRouterService` | instance id at boot | log (service is not wired into gameplay) |
| `CleanupService` | counts of rooms/challenges/guest sessions cleaned, cleanup failures | log/error |
| `ReplayWorker` | queue/skip/render success, render failures, 5-minute sweep, old GIF cleanup count | log/warn/error |

Log format is Nest's default line-oriented console output. No request ids, room ids in gateway logs beyond the message text, or structured JSON are configured.

### Client-side signals

- `match:finished` includes `persisted: boolean`; the room page can show a failure state when persistence failed.
- `error` socket events carry codes (`ROOM_FULL`, `INVALID_PASSWORD`, `RATE_LIMITED`, etc.) — currently displayed in the UI but not collected centrally.
- `apps/api/src/modules/analytics/funnel.controller.ts` accepts `POST /api/analytics/event` and exposes `GET /api/analytics/summary` behind `AdminGuard`. Events are persisted to `funnel_events` (migration `20261123_durable_render_jobs_funnel_events`); this is a product funnel table, **not** operational telemetry.

### External health checks

`docker-compose.yml` defines health checks for all four services: PostgreSQL
uses `pg_isready`, Redis uses `redis-cli ping`, the API uses Node's built-in
`fetch` to GET `/api/flags` on `:3001` (its Debian-slim image has no `wget` or
`curl`), and the web container uses `wget` to GET `/` on `:3002`. The web
service waits for `api` to become healthy before starting.
These are liveness probes only: they confirm that the HTTP process answers, not
that Prisma, Redis pub/sub or in-memory room state are healthy. There is still
**no dedicated `/health` endpoint** that reports DB connectivity or
`redisAdapter.isEnabled()`.

## 2. Minimal metrics endpoint (implemented)

`GET /api/metrics` (admin-only, `AdminGuard`) returns a small JSON payload with:

- `counts.replayBacklog` — pending/failed render jobs from `ReplayJobService.pendingCount()` (`-1` if the store is unavailable).
- `counts.activeRooms` — rooms with status `WAITING` or `PLAYING` from PostgreSQL (`-1` if the DB query fails).
- `counts.throttleRejects` — HTTP 429 responses emitted by `ThrottleGuard` since process start.
- `counters` — the raw process-local counter map (currently the throttle reject totals by route prefix).
- `redisAdapterEnabled` — `RedisAdapterService.isEnabled()`, useful for detecting single-instance degradation.

These are process-local counters that reset on restart; they are intentionally lightweight (no new dependencies, no DB writes on the request path) and complement, rather than replace, the full metrics plan below.

## 3. Proposed metrics (not implemented)

Instrument with `prom-client` or an OpenTelemetry SDK exposed at `GET /api/metrics` (internal only). Recommended first slice:

| Metric | Type | Labels | Why |
| --- | --- | --- | --- |
| `drawbattle_socket_connections` | gauge | `namespace`, `instance_id` | Detect connection drops and imbalance. |
| `drawbattle_socket_events_total` | counter | `event`, `result` (`ok`/`rejected`) | Know which handlers are hot and which reject. |
| `drawbattle_socket_event_rejections_total` | counter | `code` (`NOT_DRAWER`, `RATE_LIMITED`, …) | Abuse and UX monitoring. |
| `drawbattle_rooms_active` | gauge | `mode` | Capacity planning; in-memory rooms are unbounded today. |
| `drawbattle_players_online` | gauge | — | Concurrent user proxy. |
| `drawbattle_turn_duration_seconds` | histogram | `mode` | Detect stuck turns or timers. |
| `drawbattle_stroke_chunks_total` / `stroke_payload_bytes` | counter/histogram | `room` (cardinality risk — use buckets, not ids) | Bandwidth and validation tuning. |
| `drawbattle_match_persist_duration_seconds` | histogram | `result` (`ok`/`failed`) | The `endMatch` nested write is on the critical path. |
| `drawbattle_match_persist_failures_total` | counter | — | Should be zero; alert immediately. |
| `drawbattle_redis_adapter_enabled` | gauge | `instance_id` | Detect silent single-instance degradation. |
| `drawbattle_reconnect_total` | counter | `within_grace` (`true`/`false`) | Tune the 15 s grace period. |
| `drawbattle_match_cancelled_total` | counter | `reason` (`SERVER_RESTART`) | Track restart impact. |
| `drawbattle_http_request_duration_seconds` | histogram | `method`, `route`, `status` | REST latency and error budget. |
| `drawbattle_room_join_duration_seconds` | histogram | `result` | Serializable transaction contention signal. |

Do **not** use raw room codes, user ids or session ids as metric labels — high cardinality and privacy risk. Use coarse labels only.

## 4. Proposed structured logging (not implemented)

- Adopt JSON logs with fields: `ts`, `level`, `service`, `instanceId`, `traceId`, `roomId` (opaque internal id), `playerId` (internal id), `event`, `code`, `durationMs`, `error`.
- Add a correlation id from HTTP `X-Request-Id` / Socket.IO handshake and include it in `error` events and client console reports.
- Never log raw JWTs, room passwords, guest tokens or full stroke payloads.

## 5. Proposed traces (not implemented)

- Trace REST requests end-to-end (Nest → Prisma) using OpenTelemetry.
- For socket flows, create a span per `room:join` (auth → ban/password/capacity → init → snapshot) and per `endMatch` (score calculation → nested write → emit).
- Export to an OTLP collector; sample 10% of joins and 100% of failed persists.

## 6. Alerts (proposed thresholds — tune after a load test)

| Alert | Condition | Severity |
| --- | --- | --- |
| Match persist failing | `rate(match_persist_failures_total[5m]) > 0` | page |
| API down | health endpoint unreachable for 2 minutes | page |
| Redis adapter degraded | `redis_adapter_enabled == 0` while >1 instance expected | ticket |
| DB unavailable | join error rate > 5% for 5 minutes with DB errors | page |
| Join latency | `histogram_quantile(0.95, join_duration) > 1 s` for 10 minutes | ticket |
| Stroke propagation | `p95(stroke_propagation_ms) > 200 ms` for 10 minutes | ticket |
| Restart cancellations spike | `rate(match_cancelled_total[5m]) > 0` outside a deploy window | ticket |
| Replay backlog | `pending replays > 50` for 30 minutes | ticket |
| Memory growth | API RSS grows > 20% over 1 hour without drop | ticket (HTTP throttle buckets are never purged) |

## 7. Dashboards (proposed)

1. **Live gameplay** — active rooms, players online, events/s by type, rejections by code, p95 stroke/guess latency, active timers.
2. **Persistence health** — join latency and failures, match persist latency/failures, Prisma pool usage, cleanup counts.
3. **Infrastructure** — API CPU/memory/restarts, Redis adapter state and pub/sub errors, PostgreSQL connections/locks, replay backlog and render duration.
4. **Reliability** — reconnects (inside/outside grace), `match:cancelled` count, `persisted:false` count, rate-limit rejections.

## 8. Minimally useful first implementation

If only one sprint is available: (1) add an API `/health` endpoint that reports DB connectivity and `redisAdapter.isEnabled()`; (2) switch Nest Logger to JSON with `instanceId`; (3) expose `/metrics` with the first six metrics from §2; (4) page on persist failures and API restarts. That closes the largest blind spots called out in [failure scenarios](./failure-scenarios.md) without redesigning the game.
