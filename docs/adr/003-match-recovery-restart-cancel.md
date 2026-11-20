# ADR-003 — Cancel in-progress matches on restart instead of replaying them

- Status: Accepted (current design), partial multi-client delivery
- Date: 2026-11-20 (documented; behaviour added by commit `92b3e23` and earlier P0 work)

## Context

After the API process restarts, the database can still say `Room.status = PLAYING` while all live state (drawer order, word, strokes, guesses, scores, timers) is gone. Clients may still show the old match UI. Continuing a match from a stale DB row is impossible without a state log (see [ADR-001](./001-in-memory-match-state.md)).

## Decision

When a player joins a room and the gateway finds no in-memory snapshot, it loads the DB room. If the status is `PLAYING`, it resets it to `WAITING` and emits `match:cancelled { reason: 'SERVER_RESTART' }` to that socket. It then rebuilds the in-memory room from active `RoomPlayer` rows, repairs the host pointer if the stored host is no longer active, and sends a fresh snapshot. Clients start a new match from the waiting room.

## Consequences

Positive:

- No phantom in-progress room: the next join resets stale status in the DB.
- Host pointer is repaired from active players, so the rebuilt room is immediately usable.
- The cancellation reason is explicit, allowing the client to show a specific message.

Negative / limitations:

- Only the rejoining socket receives `match:cancelled`. Other clients keep stale UI until they reconnect or emit `state:resync`; there is no broadcast cancellation because no socket remains in the room after a process restart.
- If nobody rejoins, the stale `PLAYING` row remains until cleanup or another join.
- Scores, strokes and the partially played word are lost — not recoverable.
- The reset is done by the first joiner's process; with multiple API instances, another instance may still hold an in-memory snapshot for the same room (see [ADR-004](./004-room-ownership-lease-vs-single-instance.md)).

## Alternatives considered (not implemented)

- Persist an event log and resume matches on startup: high complexity, not justified for short casual games yet.
- Broadcast a global "server restarted" event to all connected clients on boot: would need durable connection tracking outside the process.
