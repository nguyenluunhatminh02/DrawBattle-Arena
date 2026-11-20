# Architecture Decision Records

These ADRs describe decisions **visible in the current code**, including decisions that were only partially carried through. They are not a wish list.

| ADR | Title | Status |
| --- | --- | --- |
| [001](./001-in-memory-match-state.md) | In-memory match state with PostgreSQL written at match end | Accepted (current design), with known recovery gap |
| [002](./002-soft-room-membership-and-db-authoritative-bans.md) | Soft room membership and DB-authoritative kick bans | Accepted (current design) |
| [003](./003-match-recovery-restart-cancel.md) | Cancel in-progress matches on restart instead of replaying them | Accepted (current design), partial multi-client delivery |
| [004](./004-room-ownership-lease-vs-single-instance.md) | Room-ownership lease scaffold vs actual single-instance deployment | Partial / unresolved |
| [005](./005-redis-adapter-failure-degrades-to-single-instance.md) | Redis adapter failure degrades to single-instance broadcast | Accepted (current design) |

Status meanings: **Accepted (current design)** = the code does this deliberately; **Partial / unresolved** = scaffolding exists but the decision is not fully implemented.
