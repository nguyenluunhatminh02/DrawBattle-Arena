# ADR-005 — Redis adapter failure degrades to single-instance broadcast

- Status: Accepted (current design)
- Date: 2026-11-20 (documented; design predates this documentation)

## Context

Socket.IO emits (`server.to(roomId).emit(...)`) only reach sockets connected to the local process. `@socket.io/redis-adapter` can fan out across processes through Redis pub/sub. Redis is already present in the deployment for other features, but it is optional for local development (`apps/api/.env.example` documents `REDIS_URL`).

## Decision

`RedisAdapterService` creates two Redis clients only when `REDIS_URL` is set. It installs the adapter in `afterInit` via `configureAdapter(server)`, which the gateway calls. If connecting or configuring fails, the error is logged and the service leaves the clients null; the API continues with native single-process Socket.IO behaviour. `isEnabled()` exposes the state but is not used to reject traffic.

## Consequences

Positive:

- The app boots and remains playable without Redis, which keeps local setup simple.
- A Redis outage after startup does not crash the API; Redis client `error` events are logged.

Negative / limitations:

- Degradation is silent to users: with multiple API processes and no adapter, clients see only local broadcasts. There is no health-check signal that cross-instance fan-out is disabled.
- Redis is not a state store here: installing the adapter does not replicate `GameStateService` or rate-limit buckets (see [ADR-004](./004-room-ownership-lease-vs-single-instance.md)).
- The adapter is installed after the Nest socket server is created; any emit before `afterInit` would be local-only. No such emit exists on the join path today.

## Alternatives considered (not implemented)

- Fail startup when `REDIS_URL` is configured but unreachable: stronger correctness signal, worse availability.
- Store connection state in a health endpoint: proposed in [observability plan](../observability.md), not implemented.
