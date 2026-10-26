---
paths:
  - "apps/*/**/*.go"
  - "apps/*/backend/**/migrations/**"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
  - "migrations/**"
---

# Read Cache Rule

Package managers send thousands of requests a second, and most of what a request reads (its space, repository, settings, roles, rules) changes a few times a day. Such reads go through the per-server read cache (`libs/go-common/gencache`), never straight to Postgres on every request. How it works: `doc/internal-dev-doc/common-lib/gencache/README.md`.

The model, which every use must keep:

- **Postgres decides what is fresh.** A cached table carries the cache generation triggers, so every write, from any server, any code path or plain SQL, bumps its counter when the writing transaction commits and announces it. Servers drop entries on the notice and also check the counters every `READ_CACHE_CHECK_INTERVAL` (1s) in case a notice was lost.
- **Unconfirmed entries aren't served.** A server that can't read the counters for `StaleAfter` (3 check intervals) reads the database instead, and a table without the triggers is never cached.
- **Redis plays no part.** The cache works the same on one server without Redis and in a cluster with Redis down.
- **`READ_CACHE_ENABLED=false` turns it off** on a server: every `Get` reads the database. A feature must stay correct with it off.

## What to cache

Cache a read when all of these hold:

1. It is on a hot path: every download, every metadata read, every upload, every API call of a page that polls.
2. It is configuration-like: written by people or rare jobs, not by every request.
3. A server answering from it for at most about a second after a change elsewhere (normally under a millisecond) is acceptable.

Typical: a space or repository by key, a repository's settings, a format's per-repository settings table, roles and grants, rules (upload rules, quarantine rules, block list, cleanup policies), quota limits, upstream definitions.

## What never to cache

- Whether a credential is valid: API tokens, sessions, OAuth tokens, tickets, revocation and expiry. Read on every request, so a revoke applies on every server at once. (Fewer queries are fine: `GetTokenWithOwnerByHash` reads a token and its owner in one round trip.)
- A user's sign-in state (disabled, locked, directory off).
- Exact counters and anything a limit compares against: quota usage, seat and node counts, rate-limit buckets.
- Anything read inside a write's transaction, or to decide a write (a uniqueness check, a lock, an upsert's previous value): read it in the transaction.
- Per-request content that changes on every upload (assets, blobs, download counts), until there is a content cache designed for it.

## How to add a cached read

1. **Triggers.** Give every table the value is read from (joins included) the triggers, in the owning module's migrations:

   ```sql
   -- up
   SELECT add_cache_generation_triggers('cargo_repository_settings');
   -- down
   SELECT drop_cache_generation_triggers('cargo_repository_settings');
   ```

   Core tables go in `migrations/`, a product module's in its own migrations. A table without the triggers must never be listed in a cache: the server stops caching it and `TestReadCacheTablesHaveTriggers` fails. Never bump counters from your own SQL or `SET CONSTRAINTS ALL IMMEDIATE` around cached writes: the bump runs at commit so counter locks can't deadlock.

2. **The cache.** Build it once at startup from `deps.ReadCache` (a `SetReadCache(w *gencache.Watcher)` on the service, called from the module's `NewModule`), naming every table the loader reads:

   ```go
   // Tables are what the settings are read from; each carries the cache trigger.
   var Tables = []string{"cargo_repository_settings"}

   func (s *Service) SetReadCache(w *gencache.Watcher) {
       s.settings = gencache.New[int64, settingsRow](w, "cargo_settings", Tables...)
   }
   ```

   A nil watcher (tests, tools) gives a cache that keeps nothing, so code never checks for it.

3. **The read.** Wrap the query, not the HTTP handler:

   ```go
   got, err := s.settings.Get(ctx, repoID, func(ctx context.Context) (settingsRow, error) {
       row, err := db.New(s.pool).GetCargoSettings(ctx, repoID)
       if errors.Is(err, pgx.ErrNoRows) {
           return settingsRow{}, nil // "none" is cached too
       }
       return settingsRow{row: row, found: err == nil}, err
   })
   ```

   - Cache "not found" as a value when absence is common (most repositories have no special settings); an `ErrNoRows` error is not kept.
   - Values are shared between requests. Return a copy when callers may change it (clone slices and pointed-to structs), or cache the row and convert per call.
   - Keys hold everything the value depends on (user, scope, repository), never a token or a secret.
   - Name a cached method so a reader can tell (`Lookup` beside `GetInSpace`), and keep the uncached one for writes.

4. **The writer.** After a write commits, the service that made it calls `cache.Invalidate()` (usually `defer s.changed()` at the top of the write method), so the server that made the change rereads at once; other servers hear the trigger. Never invalidate inside the transaction.

5. **Tests.** A unit test with the cache on and off, and, for anything access-related, a two-server test like `libs/platform/access/cache_integration_test.go`: a change on one server reaches the other through the notice and through the check, and a revoke takes access away.

## New repository formats

A format gets the cache for free for what every format reads: the repository and space (`Handler.LoadRepository`), roles and selector grants, repository settings, upload rules, quota limits and the block list. A new format also:

- Gives each per-repository settings table it adds (`<format>_repository_settings`) the triggers and reads it through a cache when it is read per request.
- Reads lookups that are format configuration (signing keys' public part, distribution or channel lists, upstream mappings) through a cache, with triggers on their tables.
- Reads repositories through `Lookup`/`LoadRepository` when serving clients, never `GetInSpace` or a query of its own.
- Keeps asset, component and blob reads uncached, and builds metadata (index files, packuments) from fresh reads unless it adds a content cache with its own design and review.
- Is benchmarked with the load generator before and after: statements per download and per metadata read, with `log_statement=all`.

## Review checklist

- [ ] Hot-path reads of configuration-like data go through a `gencache.Cache`
- [ ] Every table a cache lists has `add_cache_generation_triggers` in a migration, with the drop in the down file (`TestReadCacheTablesHaveTriggers` passes)
- [ ] Nothing cached decides access after a revoke, compares against an exact counter, or is read inside a write
- [ ] Writers call `Invalidate()` after their commit; nothing invalidates inside a transaction
- [ ] Cached values are copied or treated as read-only
- [ ] Works with `READ_CACHE_ENABLED=false`, and tests cover the cache on and off
