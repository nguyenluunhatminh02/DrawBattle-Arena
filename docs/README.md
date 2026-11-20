# DrawBattle — Architecture Documentation

This directory documents the architecture **as implemented** at commit `92b3e23` (the P0 privacy/reconnect/challenge fixes). Each document states its scope and separates *current behaviour* from *proposed work*. If code and docs disagree, the code wins — open a docs fix rather than treating these pages as a specification.

| Document | Contents |
| --- | --- |
| [HLD](./hld.md) | System context, deployment topology, component boundaries, data stores, trust boundaries. |
| [LLD](./lld.md) | Module map, in-memory state model, event contracts, locking, persistence rules. |
| [Sequence diagrams](./sequences.md) | Join, turn lifecycle, reconnect, kick, restart recovery, challenge flow. |
| [ADRs](./adr/README.md) | Index of architecture decision records. |
| [Failure scenarios](./failure-scenarios.md) | Failure modes and their actual current behaviour. |
| [Observability plan](./observability.md) | What is logged today and the instrumentation backlog. |
| [Load-test plan](./load-test.md) | Scenarios, existing harness, thresholds, execution procedure. |
| [Runbook](./runbook.md) | Operational procedures for common incidents. |

## One-paragraph summary

Next.js web client (`apps/web`) talks to a NestJS API (`apps/api`) over REST (`/api/*`, set up in `apps/api/src/main.ts`) and a Socket.IO `/game` namespace (`apps/api/src/modules/socket/game-socket.gateway.ts`). PostgreSQL (Prisma) owns durable identity, room membership, bans, match results, replays and challenges; migration `20261123_durable_render_jobs_funnel_events` additionally persists replay render jobs (`render_jobs`) and product funnel events (`funnel_events`). Redis has two independent roles: an optional Socket.IO adapter for cross-instance broadcast (`apps/api/src/modules/socket/redis-adapter.service.ts`) and a room-ownership lease used by `apps/api/src/modules/socket/room-router.service.ts`. **The authoritative live match state is in-process memory in `GameStateService`; it is not reconstructed from Redis or PostgreSQL on restart.** This single fact drives most of the limitations documented below.

## Documentation conventions

- "Today" describes code that exists in this repository at the stated commit.
- "Gap" describes a known limitation, not a commitment.
- "Proposed" describes a design that has not been implemented.
- File paths are repository-relative and refer to the worktree this documentation was authored in.
