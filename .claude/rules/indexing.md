---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
---

# Indexing Rule

All search indexes must be managed through `libs/go-common/indexing`. No ad-hoc in-memory caches or manual index synchronization across nodes.

## Architecture

```
Service writes to DB
    → indexing.Manager.NotifyUpdate(ctx, "tickets", "upsert", id)
    → row in index_events (Postgres change feed), or local channel (LocalOnly)
    → Each node reads after its own cursor, batches events, fetches from DB in bulk, updates local index
```

- PostgreSQL is the source of truth — indexes are derived, not authoritative
- Each node maintains its own on-disk index (2–20GB via Bleve or similar)
- A change feed in Postgres (`index_events`, one cursor per node in `index_cursors`) synchronizes change notifications across nodes, so they reach every node whether or not Redis is up
- Events carry only IDs — nodes fetch actual data from the database

## Modes

| Mode | Transport | Redis required | Use case |
|------|-----------|:-:|---|
| Default | Postgres change feed, a cursor per node | No | Production, one node or many |
| LocalOnly | In-process channels | No | Tests |

```go
// Production: the change feed in Postgres. The Redis client (may be nil)
// also gets every event for one release, for previous-version nodes.
mgr := indexing.NewManager(pool, rdb, indexing.ManagerOptions{NodeID: idKeptWithTheIndexFiles})

// Tests
mgr := indexing.NewManager(nil, nil, indexing.ManagerOptions{LocalOnly: true})
```

## Batching

Events are batched to minimize database load:

- Default: 100 events per batch or 500ms flush interval (whichever comes first)
- App's `ApplyEvents` implementation fetches records in bulk: `WHERE id IN (...)`
- 10K updates/minute → ~120 batch DB queries/minute (not 10K individual queries)

## Index Lifecycle

### Registration

Every index must implement `indexing.IndexDefinition` and be registered at startup:

```go
mgr.Register(ticketIndex)   // implements IndexDefinition
mgr.Register(documentIndex)
go mgr.Start(ctx)
```

### Updates

Every write operation that affects indexed data must call `NotifyUpdate`:

```go
// In the service layer, after DB write
mgr.NotifyUpdate(ctx, "tickets", "upsert", ticket.ID)
mgr.NotifyUpdate(ctx, "tickets", "delete", ticket.ID)
```

### Rebuild

Full rebuild from database, coordinated with a distributed lock:

```go
mgr.Rebuild(ctx, "tickets")
```

- Only one node rebuilds at a time (a lease in Postgres, `lock.Leases`)
- Old index continues serving reads during rebuild
- Triggered automatically on first start when `Stats().Version == 0`
- Can be triggered manually via admin API

### Health Check

```go
health := mgr.Health()
```

Returns per-index status: `healthy`, `rebuilding`, `stale`, or `error`. Expose via admin API endpoint.

## IndexDefinition Interface

Each app implements this for its search indexes:

```go
type IndexDefinition interface {
    Name() string
    Rebuild(ctx context.Context) error
    ApplyEvents(ctx context.Context, events []UpdateEvent) error
    Stats() IndexStats
    Close() error
}
```

- `Rebuild` — queries all records from DB, builds full index
- `ApplyEvents` — receives a batch of IDs, fetches from DB in bulk, updates index
- `Stats` — returns document count, disk size, version, last updated time

## Rules

- Every new searchable resource must have a registered `IndexDefinition`
- Every write operation on indexed data must call `NotifyUpdate` — skipping it causes stale indexes
- `ApplyEvents` must use bulk DB queries (`WHERE id IN (...)`) — never one query per event
- Index implementations must deduplicate IDs within a batch — the same ID may appear multiple times
- Indexes must be on-disk (not in-memory) for datasets exceeding 1GB
- Index health must be exposed via an admin API endpoint
- Rebuild must be non-blocking — old index serves reads while new index is built
- No direct access to `index_events` or `index_cursors` outside the indexing package — use `Manager.NotifyUpdate`
