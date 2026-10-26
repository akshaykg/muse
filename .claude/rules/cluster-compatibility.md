# Cluster Compatibility Rule

Every feature must work identically on one node or many. Single-node and cluster mode are the same code path with different backing providers — never two implementations, never a feature that only works in one mode.

## Deployment Modes

| Mode | License | Postgres | Redis | Nodes |
|------|---------|----------|-------|-------|
| Single-node | Standard+ | Required | Optional | 1 |
| Cluster | Pro+ | Required (shared) | Required (shared) | 2..N (license limit) |

- **Postgres is the single source of truth** in both modes. All durable state lives there.
- **Redis is a coordination layer**, not a store of record. Anything in Redis must be reconstructible from Postgres or safe to lose (sessions are read from Postgres only; `auth.CompositeRepository` still writes them to Redis for one release, for previous-version nodes).
- Mode is decided at startup by `internal/cluster` (license tier + node registration). Features must not read the license tier to decide *how* to behave — they receive the right provider via dependency injection.

## Core Principle: Assume Many Nodes, Degrade to One

Write every feature as if N nodes are running behind a round-robin load balancer with no sticky sessions. Then ensure the single-node case works when Redis is `nil`.

Ask for every piece of state: **"If the next request hits a different node, is the answer still correct?"** If not, the state is in the wrong place.

## Provider Pattern (Mandatory)

Any capability that differs between modes must be an interface with a distributed and a local implementation. The choice is made once at wiring time, never inside business logic.

| Capability | Interface | Cluster impl | Single-node impl |
|------------|-----------|--------------|------------------|
| Job locking | `scheduler.LockProvider` | `LeaseLockProvider` (Postgres lease) | `LeaseLockProvider` (`NoopLockProvider` only without a database) |
| Leader election | `cluster.LeaderElector` | `LeaseLeaderElector` (Postgres lease) | always-leader (`startSingleNode`) |
| Realtime fan-out | `realtime.Broker` (`realtime.NewBroker`) | Redis Pub/Sub, Postgres NOTIFY while Redis is down | `LocalBroker` |
| Search index changes | `indexing.Manager` | Postgres change feed (`index_events`) | same |
| Sessions | `auth.Repository` | `CompositeRepository` (reads PG; writes PG + Redis for one release) | `CompositeRepository` (PG only) |
| Rate limiting | `ratelimit.Store` (behind `middleware.RateLimit`) | `RedisStore` (GCRA) | `MemoryStore` |
| Cache | `go-common/cache` | Redis | in-process |
| Read cache (hot-path configuration reads) | `gencache.Cache` (`read-cache.md`) | in-process, invalidated by Postgres triggers + NOTIFY | same |
| Cluster stats | `cluster.StatsCollector` | Redis-aggregated | `LocalStatsCollector` |

```go
// Correct — decided once at wiring time
var store ratelimit.Store = ratelimit.NewMemoryStore()
if rdb != nil {
    store = ratelimit.NewRedisStore(rdb)
}

// Wrong — mode checks scattered through business logic
if s.redis != nil {
    s.redis.Incr(ctx, key)
} else {
    s.counter++
}
```

- **Never pass a raw `*redis.Client` into a service that must work without Redis.** Pass an interface. A `nil` Redis client must never be dereferenced.
- New shared capabilities go in `libs/go-common/` with both implementations and tests for both.

## State Rules

### Forbidden: node-local authoritative state

Never hold state in process memory that another node needs to see or that must survive a restart:

- `map`, `sync.Map`, package-level vars, or struct fields used as a store of sessions, users, permissions, counters, locks, job status, or feature flags
- In-memory queues of work that must not be lost
- "Last seen" / "already processed" flags that prevent duplicate work

### Allowed node-local state

- Read-through caches **with a TTL or explicit invalidation** (see Cache Invalidation)
- Connection pools, compiled templates, parsed config
- Per-connection state (WebSocket connections — routed via `realtime.Broker`)
- Metrics/stats about *this* node (reported to the cluster via `StatsCollector`)
- Fallback counters used only when Redis is unavailable (rate limiting degrades to per-node)

### Files and uploads

- All file I/O goes through `libs/go-common/storage`. Never write user data to the local disk directly.
- Cluster mode requires a shared storage backend (`s3`, `minio`, `azure`) or a `local` path on a shared volume mounted identically on every node. Setup and cluster join must reject a non-shared `local` backend when joining a second node.
- Node-local disk is only for `./data/bootstrap.enc`, temp files deleted within the request, and this node's own log files (`LOG_FILE_DIR`); log exports collect from every node.

## Coordination Rules

### Background work

- All recurring work goes through the scheduler (see `scheduler.md`). Choose the job type deliberately:
  - `JobTypeSingletonCron` / `JobTypeSingletonInterval` — anything that writes shared state (cleanup, retention, emails, external calls). Runs once per cluster.
  - `JobTypeBroadcast` — only node-local work (cache refresh, local stats). Must be safe to run N times at once.
- No raw goroutine loops for periodic work. The only exceptions are the cluster heartbeat and leader loops in `internal/cluster`.

### Leader-only work

- Use `cluster.Service.IsLeader()` only for work that must have exactly one owner continuously (e.g. dead-node detection). Prefer singleton scheduler jobs for everything else.
- Leader work must tolerate a leader change mid-operation: check leadership before each batch, not once at start.

### Locks

- Every distributed lock must have a TTL. No lock may be held forever.
- Lock values must identify the owner (node/machine ID). **Release and renew must be compare-and-delete / compare-and-expire** (atomic Lua script) — never a plain `DEL` or a `GET` followed by `EXPIRE`, which lets a node release a lock another node now holds.
- Work protected by a lock must finish within the TTL or renew it. Set `MaxDuration` on jobs.

### Idempotency and concurrency

- Any operation that can be triggered from two nodes simultaneously must be idempotent or guarded by a DB constraint.
- Use Postgres for correctness: unique constraints, `INSERT ... ON CONFLICT`, `SELECT ... FOR UPDATE SKIP LOCKED`, and optimistic version columns. Redis locks reduce duplicate work; the database guarantees correctness.
- Counters and quotas that must be exact (license seat limits, node limits) are enforced in Postgres inside a transaction, not in Redis.

### Events and realtime

- Anything a user on another node needs to see live is published through `realtime.Broker` / hooks, never delivered directly to a local connection only.
- Consumers must tolerate duplicate and out-of-order delivery. Redis Pub/Sub is at-most-once — never use it as the only record of an event. Persist first (Postgres), then publish.

### Cache invalidation

- A write on node A must invalidate caches on all nodes. Either:
  - cache in Redis only (shared), or
  - cache locally with a short TTL **and** publish an invalidation message through the broker.
- Permission and session caches must be invalidated cluster-wide on role change, logout, or revocation (`auth.InvalidatePermissionCache`).

## Redis Topologies

Redis may be one server, a Sentinel group or a Redis Cluster (`libs/go-common/cache`, chosen by the URL scheme). Code must run on all three:

- Take `redis.UniversalClient` (or `redis.Cmdable` / `redis.Scripter`), never `*redis.Client`.
- One command, `MULTI` or Lua script touches keys in one cluster slot only: one key per script, or keys sharing a hash tag (`{user:7}:a`). Multi-key `DEL`/`MGET` and `TxPipeline` over unrelated keys fail with `CROSSSLOT`; use a plain pipeline.
- Use `cache.ScanKeys`, not `SCAN`/`KEYS` (a plain scan sees one shard). Only database 0 exists on a cluster.
- A failover can drop the last writes (asynchronous replication), including a lock or leader key: Postgres stays the guarantee.
- Anything that talks to Redis directly gets a test against `redistest.Cluster`.

## Redis Failure Behavior

Redis may disappear at runtime in cluster mode. Each feature must declare its degraded behavior, and it must be one of:

| Behavior | When to use | Example |
|----------|-------------|---------|
| Postgres only | State needed for correctness, which Redis could serve stale or split after an outage | Sessions, leader election, singleton job locks |
| Fall back to Postgres | Delivery that must go on, where Postgres can carry it | Live updates (NOTIFY; messages over 7.9 KB are refused) |
| Fall back to per-node | Approximate is acceptable | Rate limiting, cache |
| Fall back to per-node, still enforced | Brute-force limits, where refusing everyone would be an outage | Failed sign-in and unknown-token limit per address (`auth.LockoutManager`): each node counts on its own, so guessing is still limited |
| Fail closed | Security controls whose state can't be approximated | Per-account lockout (Postgres), CAPTCHA requirement |
| Pause | Duplicate execution would be harmful | Singleton jobs skip the tick when Postgres (their lock) is unavailable |

- Never fail open on a security control: never skip the check. A brute-force counter may degrade to counting per node (decided 2026-10-06, so a Redis outage doesn't stop every sign-in and CI build); anything else that can't be read refuses.
- Log a `warn` once per transition (healthy → degraded → healthy), not per request.
- Surface degraded mode in cluster status (`/api/cluster` + Settings → Clustering).

## Node Identity and Lifecycle

- Node identity is `machine_id` (license fingerprint) + DB `node_id`. Never use hostname, PID, or IP as identity — containers reuse them.
- Every node must handle `SIGTERM` gracefully: stop accepting requests, finish or cancel running jobs within `MaxDuration`, release locks and leadership, mark itself leaving.
- Nodes must be able to run different versions during a rolling upgrade (see Migrations).

## HTTP and API

- No sticky sessions. Any node must serve any request. Auth state comes from the cookie/token → shared session store.
- Do not store request-spanning state (upload progress, multi-step wizards, OAuth `state`) in memory. Use Postgres or Redis with TTL.
- WebSocket clients may reconnect to a different node; on connect, send current state from the shared store (`realtime.HubConfig.OnConnect`).

## Migrations and Rolling Upgrades

- Migrations run exactly once, guarded by a DB advisory lock (only one node migrates; others wait).
- Schema changes must be backward compatible for one release: add columns nullable/defaulted, backfill in a singleton job, drop old columns in a later release. Old and new nodes share the database during an upgrade.
- Leader election prefers the highest version (`ShouldRelease`), so new behavior runs on upgraded nodes first.

## Configuration

- Cluster-wide settings live in Postgres (encrypted via `internal/config`) and are read on every node. Changing a setting must propagate to all nodes (broker invalidation or short TTL reload).
- Env vars are per-node and only for bootstrap/tuning (`PORT`, `LOG_LEVEL`, heartbeat interval). Never put a setting in env that must be identical across nodes.

## Testing Requirements

Every feature that touches state, background work, or realtime must have:

1. **Single-node test** — `nil` Redis, Noop/Local providers.
2. **Multi-node test** — two or more service instances sharing one Postgres and one Redis (`miniredis`), asserting:
   - singleton work runs once
   - a write on instance A is visible on instance B
   - cache/permission invalidation reaches B
3. **Redis-loss test** — Redis stopped mid-test; assert the declared degraded behavior.

Property tests (`rapid`) should randomize node count (1..5) where practical.

## Review Checklist

Before merging a feature, confirm:

- [ ] No authoritative state in process memory
- [ ] Works with Redis `nil` (no nil dereference, no panic)
- [ ] Redis-backed capability is behind an interface with a local implementation
- [ ] Background work uses the scheduler with the correct job type
- [ ] Locks have TTLs and owner-checked release/renew
- [ ] Concurrent execution from two nodes is idempotent or DB-guarded
- [ ] Cross-node events are persisted first, then published
- [ ] Caches are invalidated cluster-wide on write
- [ ] Degraded behavior on Redis loss is defined and fails closed for security
- [ ] Files go through `go-common/storage`
- [ ] Schema changes are backward compatible for one release
- [ ] Single-node, multi-node, and Redis-loss tests exist
