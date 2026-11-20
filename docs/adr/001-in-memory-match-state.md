# ADR-001 — In-memory match state with PostgreSQL written at match end

- Status: Accepted (current design), with known recovery gap
- Date: 2026-11-20 (documented; design predates this documentation)

## Context

DrawBattle live play involves high-frequency stroke chunks (up to 30/s per drawer), per-turn guesses, countdowns and score updates. Persisting every stroke or guess to PostgreSQL would add a transaction to the hot path and complicate ordering. The room is small (2–8 players) and short-lived.

## Decision

`GameStateService` keeps the authoritative live state in process memory: `rooms: Map<roomId, RoomState>` with players, current turn, strokes, guesses and scores. Event output goes through a per-room sink registered by the gateway. PostgreSQL holds identity, room membership, word catalogue and **final** match results: `endMatch` performs one nested `match.create` containing rounds, turns, replay strokes, guesses and scores.

## Consequences

Positive:

- Stroke propagation and guess scoring are memory-speed; no DB round trip per event.
- Per-room locks (`withLock`) serialize match transitions without database contention.
- Match persistence is atomic: a result is either written as one graph or reported as `persisted: false`.

Negative / honest limitations:

- An API restart destroys every in-progress match. Redis pub/sub and the room-owner lease do not replicate state.
- There is no periodic checkpoint of strokes or scores. A crash between `startMatch` and `endMatch` loses that match permanently.
- `Room.status = PLAYING` in PostgreSQL is a stale hint after a crash; recovery relies on the join path resetting it (see [ADR-003](./003-match-recovery-restart-cancel.md)).
- Horizontal scaling is not safe without room affinity: two API processes handling the same room would each hold divergent state even if broadcasts were shared.

## Alternatives considered (not implemented)

- Write-ahead event log in Redis/Postgres, replay on startup — would allow resume, but adds ordering, compaction and replay correctness work.
- Store full match state in Redis as JSON — would make state shareable, but large stroke arrays and frequent writes make this expensive and still need atomic transitions.

## Verification of current behaviour

- `apps/api/src/modules/game/game-state.service.ts` — `rooms`, `withLock`, `endMatch` nested `prisma.match.create`.
- `apps/web/socket-restart-e2e.mjs` — restart scenario proves state is not recovered and a cancellation is sent instead.
