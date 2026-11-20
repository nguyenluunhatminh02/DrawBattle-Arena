# DrawBattle Arena

Realtime multiplayer drawing & guessing game — draw a word, share a link, have friends guess.

## Stack

- **Frontend:** Next.js 15 (App Router) + Tailwind CSS + shadcn/ui + Zustand
- **Backend:** NestJS + Socket.IO + Prisma
- **Database:** PostgreSQL 16
- **Cache/Broadcast:** Redis (Socket.IO adapter for multi-instance)
- **Monorepo:** pnpm workspaces (`apps/api`, `apps/web`, `packages/shared`)

## Quick start

```bash
pnpm install
docker compose up -d postgres redis    # PostgreSQL :5440, Redis :6390 (host binds are loopback-only)
pnpm --filter @drawbattle/api db:generate
pnpm --filter @drawbattle/api exec prisma migrate deploy
pnpm --filter @drawbattle/api db:seed  # 163 Vietnamese words
pnpm --filter @drawbattle/shared build
pnpm dev                               # API :3001 + Web :3002
```

Open http://localhost:3002.

## Status

**Not production-ready.** This is a functional prototype with passing automated
regression tests, but it has known architectural, security and operational
limits (see [Known Limitations](#known-limitations)). Do not expose it to
untrusted public traffic without the work listed there.

### Recent Security & Correctness Fixes (Nov 2026)
- ✅ NestJS DI: Fixed module imports for AdminGuard
- ✅ Migration dedup: Baseline migration now complete, incremental migrations are no-ops
- ✅ Room password hash: Stripped from API responses
- ✅ Challenge finalize: Requires authentication, strict ownership check
- ✅ Canvas rendering: Incremental drawing (performance improvement)
- ✅ Room join: Serializable isolation level
- ✅ Admin UI: Uses account JWT instead of guest token
- ✅ Daily challenge: Word answer no longer leaked in API
- ✅ Drawer reconnect: Private word event on rejoin
- ✅ Replay worker: Concurrency limits (max 3 active jobs)
- ✅ Redis throttling: Shared HTTP buckets recover automatically after transient Redis failures (process-local fallback while Redis is unavailable)
- ✅ Replay reconciliation: Orphaned replay rows are reconciled and render workers shut down cleanly on restart

### Known Limitations
These are open architecture/operations gaps, not covered by the regression suite:

- **Multi-instance**: Redis adapter broadcasts Socket.IO events only; authoritative game state (timers, turns, scores, strokes) is in-memory per API process. A room is pinned to one instance via a Redis ownership key; there is no state handoff or cross-node recovery.
- **Crash recovery**: An in-progress match is lost when its API process restarts; only finished matches are persisted.
- **Dependency security**: The app now uses Next.js 15.5.29 and the current `pnpm audit --prod` baseline is **3 advisories** (1 high, 2 moderate); re-audit dependencies before any public deployment (see [docs/failure-scenarios.md](./docs/failure-scenarios.md#15-production-dependency-advisories-after-p1-04)).
- **Leaderboard**: All-time view is capped at the 2000 most recent matches; rankings are approximate.
- **Rate limiting**: Shared fixed-window buckets in Redis when `REDIS_URL` is reachable, with a process-local fallback during Redis outages. Authenticated identity keys and `TRUST_PROXY` mitigate spoofing but the fallback is not distributed and resets on restart.
- **Persistence/retention**: Drawings (strokes) and guesses are stored with finished matches and replay rows; there is no automated retention/privacy deletion job yet.
- **Replay rendering**: GIF render jobs and funnel events are persisted in PostgreSQL (`render_jobs`, `funnel_events`) by migration `20261123`, with retry counters and stale-lease recovery after a restart. Rendering itself is capped at 3 concurrent jobs per API process and GIF files still live on the API container filesystem.
- **Admission control**: No load shedding or admission queue; overload can exhaust the API process.
- **Observability**: Default Nest console logs and a small admin-only `GET /api/metrics` JSON snapshot (process-local counters; see [docs/observability.md](./docs/observability.md)). No Prometheus/OTLP exporter, distributed tracing, request ids, or alerting; there is no dedicated `/health` endpoint.
- **Deployment/rollback**: Compose is suitable for a single host. `scripts/rollback-check.sh` documents the rollback procedure; automated image/DB snapshot rollback must be wired per environment.

## Features (implemented)

### Phase 0+1 — Core game
- **Quick Challenge** — pick a word, draw in 15s, share a link, friends guess (max 3 attempts)
- **Live Room** — 2–8 players, host starts, rotate drawers, realtime canvas sync, scoring
- **Canvas sync** — vector strokes normalized to [0,1], streaming batch (50ms), undo support
- **Guest auth** — JWT + guest sessions, optional account upgrade
- **163 Vietnamese words** across 10 categories (3 difficulty levels)
- **Rate limiting**, **profanity filter** (VN diacritics-aware), **match history**, **reports**
- **Host actions** — kick, mute, transfer host
- **Reconnection** — 15s grace period, state resync

### Phase 2 — Accounts & retention
- **Register/Login/Profile** — bcrypt password hashing, avatar upload (sharp)
- **Daily Challenge** — one word per day, streak tracking
- **Leaderboard** — daily/weekly/alltime snapshots with abuse filter
- **Feature flags** — A/B testing (turn duration, hints on/off)
- **Moderation dashboard** — report management, admin-only endpoints
- **Replay GIF** — worker thread rendering (canvas + gif-encoder-2)

### Phase 3 — Game modes
- **Speed Round** — 30s turns, 5s word pick
- **1v1 Duel** — 2 players, 3 total turns, 45s each
- **Team Battle** — 4+ players, 2 teams, teammate guess blocked
- **Redis adapter** — Socket.IO broadcast across instances

### Security
- **AdminGuard** — RBAC for admin endpoints (feature flags, moderation)
- **Guest ownership** — linkGuestToUser requires valid guest token verification
- **Server-side solverId** — challenge guess identity derived from auth token
- **Reconnect race protection** — socket identity verified before disconnect cleanup

## Project structure

```
apps/
  api/          NestJS REST + Socket.IO gateway, Prisma schema, game state machine
  web/          Next.js app router, canvas component, room & challenge pages
packages/
  shared/       Types, validators (zod), game rules, constants — shared by both apps
```

## Key contracts

- Socket namespace: `/game` — auth via `socket.handshake.auth.token`
- Room state: in-memory per instance with Redis-based room ownership routing
- Strokes: normalized vector points (`x,y ∈ [0,1]`), not rasterized — cheap to replay and broadcast
- Server-authoritative: timers, scoring, phase transitions, secret word never sent to non-drawers
- GIF rendering: offloaded to worker threads (non-blocking)

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | run API + Web in parallel (watch mode) |
| `pnpm build` | build shared + api + web |
| `pnpm typecheck` | tsc --noEmit across all workspaces |
| `pnpm test` | jest (28 unit tests) |
| `pnpm docker:up` | start all services via Compose |

## Testing

```bash
pnpm --filter @drawbattle/api test          # unit + in-memory regression specs
pnpm --filter @drawbattle/api test:integration  # TEST-01..TEST-14 against PostgreSQL/Redis
bash scripts/test-migration-clean.sh        # clean DB migration check
node apps/web/socket-e2e.mjs                # classic 2-player match
node apps/web/socket-modes-e2e.mjs speed    # SPEED mode
node apps/web/socket-modes-e2e.mjs duel     # DUEL mode
node apps/web/socket-modes-e2e.mjs team     # TEAM mode
node apps/web/socket-modes-e2e.mjs ab       # A/B flag
node apps/web/socket-stream-e2e.mjs         # stroke streaming + merge
node apps/web/socket-room-e2e.mjs           # room management
node apps/web/socket-load.mjs               # load test (env: LOAD_ROOMS, LOAD_PLAYERS)
npx playwright test                         # browser + HTTP e2e (E2E-01..E2E-10)
SMOKE_API_URL=http://localhost:3001 SMOKE_WEB_URL=http://localhost:3002 bash scripts/smoke-test.sh
bash scripts/rollback-check.sh              # health check + rollback guidance
```

Integration tests need `DATABASE_URL` and `REDIS_URL` pointing at a migrated
database and Redis instance (CI provisions both as service containers). The
Playwright suite expects the API on `:3001` and web on `:3002`; override with
`E2E_API_URL` / `E2E_WEB_URL`.

CI runs: install/build → migrate → seed → typecheck → unit tests → DB
integration tests → clean migration check → builds → Playwright e2e →
post-deploy smoke check.

## Docker

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
```

- API on `:3001`, Web on `:3002`, PostgreSQL on `:5440`, Redis on `:6390`
- PostgreSQL and Redis host ports bind to `127.0.0.1` by default; only publish them on a trusted network (e.g. `0.0.0.0:5440:5432`) because they ship with default/no credentials
- Compose health checks probe all four services (`/api/flags` for API, `/` for web); the API/web checks are liveness only, not `/health`
- The API container runs `prisma migrate deploy`, seeds the catalogue only if the `words` table is empty, then starts the server

## Architecture decisions

1. **In-memory room state + Redis Socket.IO adapter** — authoritative game state is process-local; the Redis adapter only fans out Socket.IO events. Rooms are not migrated between API instances, so multi-instance scaling requires sticky room routing.
2. **Shared package with dual ESM/CJS output** — tsup builds both `index.mjs` and `index.js` from one source
3. **Server-authoritative scoring with idempotent correct-guess** — prevents duplicate points on retransmit
4. **Vector strokes, not raster** — bandwidth-friendly, replayable, resolution-independent
5. **Guest-first identity** — JWT + `guest_sessions`, optional account upgrade with token-verified linking
6. **Worker thread GIF rendering** — CPU-intensive canvas rendering offloaded from main event loop
