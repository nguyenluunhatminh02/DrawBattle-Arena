# ADR-002 — Soft room membership and DB-authoritative kick bans

- Status: Accepted (current design)
- Date: 2026-11-20 (documented; design predates this documentation)

## Context

A disconnection must not immediately free a room slot: mobile clients drop WebSocket connections often, and a slot freed too early lets a different player take it. Conversely, a kicked player must never be able to rejoin by rotating sockets or sessions, including after an API restart.

## Decision

Room membership is soft-deleted: `RoomPlayer.leftAt` is nullable with an index on `(roomId, leftAt)` and uniques on `(roomId,userId)` and `(roomId,guestSessionId)`. On disconnect the gateway marks the player offline in memory, starts a 15 s timer, and only after `leaveRoom` has set `leftAt` removes the in-memory player. A reconnect with the same identity before that point returns the same `playerId`, bypasses capacity, cancels the timer and may re-enter a password-protected room only after the password is checked again.

Kicks create `RoomBan` rows keyed by `(roomId,userId)` and `(roomId,guestSessionId)`, resolved from the DB `RoomPlayer` row (not from socket claims) before the player is evicted. `RoomService.joinRoom` checks bans inside its `Serializable` transaction; the gateway's `kickedSessions` map is only a fast path.

## Consequences

Positive:

- Grace period handles transient disconnects without losing score/slot.
- Password re-check before the reconnect early return closes the password-free rejoin hole.
- Bans survive process restarts and cannot be bypassed with a fresh socket.

Negative / limitations:

- A player who disconnects and never returns still occupies a slot for 15 s; the room cannot refill instantly.
- `kickedSessions` is per-process memory. With multiple API instances a kicked identity can hit another instance that has no fast-path entry, but the DB check still denies the join.
- Guest bans are tied to a guest session id; a guest who creates a new session is a new identity (not a durable device/user ban).
- `CleanupService` will not delete a guest session while any active `RoomPlayer` references it; the 15 s timer must complete.

## Alternatives considered (not implemented)

- Hard delete on disconnect: simpler but removes reconnect continuity and scores.
- IP/device bans: stronger for guests, but higher false-positive risk and requires a new identity signal.
