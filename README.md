# DrawBattle Arena

Realtime multiplayer drawing & guessing game — draw a word, share a link, have friends guess.

## Stack

- **Frontend:** Next.js 14 (App Router) + Tailwind CSS + shadcn/ui + Zustand
- **Backend:** NestJS + Socket.IO + Prisma
- **Database:** PostgreSQL 16
- **Cache/Broadcast:** Redis (Socket.IO adapter for multi-instance)
- **Monorepo:** pnpm workspaces (`apps/api`, `apps/web`, `packages/shared`)

## Quick start

```bash
pnpm install
docker compose up -d postgres redis    # PostgreSQL :5440, Redis :6379
pnpm --filter @drawbattle/api db:generate
pnpm --filter @drawbattle/api exec prisma migrate deploy
pnpm --filter @drawbattle/api db:seed  # 163 Vietnamese words
pnpm --filter @drawbattle/shared build
pnpm dev                               # API :3001 + Web :3002
```

Open http://localhost:3002.

## Status

**Production-ready** with known architectural limitations (see Known Limitations below).

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

### Known Limitations
- **Multi-instance**: Redis adapter for broadcast only; game state still in-memory per process
- **Crash recovery**: Match in progress lost on server restart
- **Next.js 14.2.4**: 75 security advisories (5 critical) — upgrade recommended before production
- **Leaderboard**: All-time capped at 2000 most recent matches

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
pnpm --filter @drawbattle/api test          # 28 unit tests
node apps/web/socket-e2e.mjs                # classic 2-player match
node apps/web/socket-modes-e2e.mjs speed    # SPEED mode
node apps/web/socket-modes-e2e.mjs duel     # DUEL mode
node apps/web/socket-modes-e2e.mjs team     # TEAM mode
node apps/web/socket-modes-e2e.mjs ab       # A/B flag
node apps/web/socket-stream-e2e.mjs         # stroke streaming + merge
node apps/web/socket-room-e2e.mjs           # room management
node apps/web/socket-load.mjs               # load test (env: LOAD_ROOMS, LOAD_PLAYERS)
npx playwright test                         # browser e2e (4 tests)
```

## Docker

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
```

- API on `:3001`, Web on `:3002`, PostgreSQL on `:5440`, Redis on `:6379`
- The API container runs `prisma migrate deploy` before starting

## Architecture decisions

1. **In-memory room state + Redis ownership routing** — simple per-instance state machine, Redis tracks which instance owns each room for multi-instance scaling
2. **Shared package with dual ESM/CJS output** — tsup builds both `index.mjs` and `index.js` from one source
3. **Server-authoritative scoring with idempotent correct-guess** — prevents duplicate points on retransmit
4. **Vector strokes, not raster** — bandwidth-friendly, replayable, resolution-independent
5. **Guest-first identity** — JWT + `guest_sessions`, optional account upgrade with token-verified linking
6. **Worker thread GIF rendering** — CPU-intensive canvas rendering offloaded from main event loop
