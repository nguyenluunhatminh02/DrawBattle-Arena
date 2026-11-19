# DrawBattle Arena

Realtime multiplayer drawing & guessing game — draw a word, share a link, have friends guess.

## Stack

- **Frontend:** Next.js 14 (App Router) + Tailwind CSS + shadcn/ui + Zustand
- **Backend:** NestJS + Socket.IO + Prisma
- **Database:** PostgreSQL 16
- **Monorepo:** pnpm workspaces (`apps/api`, `apps/web`, `packages/shared`)

## Quick start

```bash
pnpm install
docker compose up -d postgres          # PostgreSQL on :5440
pnpm --filter @drawbattle/api db:generate
pnpm --filter @drawbattle/api exec prisma db push
pnpm --filter @drawbattle/api db:seed  # 163 Vietnamese words
pnpm --filter @drawbattle/shared build
pnpm dev                               # API :3001 + Web :3002
```

Open http://localhost:3002.

## Game modes (Phase 0 + 1)

- **Quick Challenge** — pick a word, draw in 15s, send a link, friends guess (max 3 attempts).
- **Live Room** — 2–8 players, host starts, rotate drawers, realtime canvas sync, scoring.

## Project structure

```
apps/
  api/          NestJS REST + Socket.IO gateway, Prisma schema, game state machine
  web/          Next.js app router, canvas component, room & challenge pages
packages/
  shared/       Types, validators (zod), game rules, constants — shared by both apps
```

## Key contracts

- Socket namespace: `/game` — auth via `socket.handshake.auth.token` (JWT from `POST /api/guest-sessions`).
- Room state is kept in-memory on the API process for the MVP; match results and challenges are persisted to PostgreSQL.
- Strokes are stored as normalized vector points (`x,y ∈ [0,1]`), not rasterized — cheap to replay and broadcast.
- Server is authoritative on timers, scoring, phase transitions, and the secret word (never sent to non-drawers).

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | run API + Web in parallel (watch mode) |
| `pnpm build` | build shared + api + web |
| `pnpm typecheck` | tsc --noEmit across all workspaces |
| `pnpm test` | jest across workspaces (game-rules, gateway) |
| `pnpm docker:up` | start all services via Compose |

## Testing

```bash
pnpm --filter @drawbattle/api test          # unit tests (game rules, scoring)
node apps/web/socket-e2e.mjs                # headless 2-player match over socket.io
```

The e2e script creates two guest sessions, creates a room, joins both sockets, runs a full match (WORD_PICK → DRAWING → REVEAL → MATCH_RESULT), and verifies the lobby snapshot and final rankings.

## Docker

Production images are multi-stage. Run the full stack:

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
```

- API on `:3001`, Web on `:3002`, PostgreSQL on `:5440` (host).
- The API container runs `prisma migrate deploy` before starting.

## Architecture decisions (ADR summary)

1. **In-memory room state for MVP** — simple, correct, observable. Acceptable single-node failure mode; Redis adapter is the documented Phase 3 upgrade path once load tests justify it.
2. **Shared package with dual ESM/CJS output** — tsup builds both `index.mjs` (Next.js) and `index.js` (NestJS) from one source, keeping socket event contracts in sync.
3. **Server-authoritative scoring with idempotent correct-guess flag** — prevents duplicate points on retransmit and stops the drawer from self-scoring.
4. **Vector strokes, not raster** — bandwidth-friendly, replayable, canvas-resolution-independent.
5. **Guest-first identity** — JWT + `guest_sessions` table, optional account upgrade later. Room rejoin uses the same token, no duplicate players on refresh.

## Status

Phase 0 + 1 implemented. Phase 2 (daily draw, accounts, leaderboard, replay GIF) and Phase 3 (multi-instance Socket.IO, Redis adapter, load tests) are described in `DrawBattle_Arena_Full_Feature_Spec_VI.md`.
