# ADR-004 — Room-ownership lease scaffold vs actual single-instance deployment

- Status: Partial / unresolved
- Date: 2026-11-20 (documented; scaffold predates this documentation)

## Context

Socket.io rooms and the game state Maps are process-local. To run multiple API instances safely, each room would need an owner instance, with joins routed to that owner and state reconstructed or migrated on failover. A lease in Redis is a common way to express ownership.

## Decision (as far as the code goes)

`RoomRouterService` generates an `instanceId`, tracks `localRooms`, and offers `claimRoom`, `getRoomOwner`, `isLocalRoom`, `releaseRoom` and `refreshTTL` against `room:owner:<roomId>` with a 7200 s TTL. The intent is visible in the service name and methods.

**The decision is not carried through.** No code calls `setRedis(...)` on the router, and no gateway handler calls `claimRoom`, `refreshTTL` or `releaseRoom`. `socket.module.ts` provides the gateway and `RedisAdapterService` but not `RoomRouterService`. The shipped `docker-compose.yml` defines exactly one `api` container with no load balancer.

Therefore the current architecture is effectively **single-instance for gameplay**, with cross-instance broadcast only if the Redis adapter is enabled.

## Consequences

Positive:

- The lease scaffold documents an intended direction without changing current behaviour.
- Single-instance operation is internally consistent: one state owner per room, no split-brain.

Negative / honest limitations:

- Do not deploy multiple API replicas behind a load balancer expecting room affinity. Without affinity and ownership enforcement, two processes can hold divergent state for the same room.
- Never interpret `room:owner:*` keys as authoritative: they are never written by the running code.
- If room ownership is implemented later, TTL renewal and release-on-shutdown must be wired into join/leave/disconnect paths, and `GameStateService` must be made relocatable or reconstructible. Sticky sessions alone are insufficient if state is lost on restart.

## Alternatives considered

- **Chosen for now:** one API instance. Documented in [HLD §2](../hld.md).
- **Future:** explicit owner lease + state checkpoint/transfer, or a shared state store. Requires ADR-001 to change first.
