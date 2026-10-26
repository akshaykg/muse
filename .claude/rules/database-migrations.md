---
paths:
  - "migrations/**"
  - "libs/platform/db/**"
  - "libs/platform/sqlc.yaml"
  - "libs/go-common/db/**"
---

# Database Migration Rule

All database schema changes must go through versioned migration files. No manual schema edits are ever acceptable.

## Tooling

- Use `golang-migrate` via `libs/go-common/db` — call `db.Migrate()` at startup
- Migration files are raw `.sql` files — no Go code migrations
- Stored in `migrations/` directory at the repo root

## File Naming Convention

```
{timestamp}_{description}.up.sql
{timestamp}_{description}.down.sql
```

Example:
```
20260422001_create_users_table.up.sql
20260422001_create_users_table.down.sql
```

- Timestamp format: `YYYYMMDDNNN` where `NNN` is a sequence number for that day
- Description is snake_case, concise, and descriptive
- Every migration must have both an `up` and `down` script

## Tracking

- A `schema_migrations` table tracks which migrations have been applied
- Applied migrations are never rerun — tracked by version number
- Never manually modify the `schema_migrations` table

## Startup Behavior

- Migrations run automatically on app startup via `db.Migrate()` before the server accepts requests
- If a migration fails, the app must fail to start with a clear error message
- Migration run is logged at `INFO` level via `logger.Package("db")` with version numbers applied

## Fresh Install vs Upgrade

### Fresh Install (empty database)
1. Detect empty DB (no `schema_migrations` table)
2. Apply baseline schema if one exists for the current major version (`baseline_vX.sql`)
3. Mark all migrations up to the baseline as applied in `schema_migrations`
4. Run any remaining new migrations on top of the baseline

### Upgrade (existing database)
1. Detect current schema version from `schema_migrations`
2. Run all pending migrations in order
3. Each migration is atomic — wrapped in a transaction where possible

## Baseline Migrations

- For each major version, a consolidated `baseline_vX.sql` is maintained
- Represents the full schema at that major version
- Allows fresh installs to skip replaying all historical migrations
- Located at `migrations/baselines/baseline_vX.sql`

## Pre-flight Checks

On startup, before running migrations:
- Detect whether DB is a fresh install or existing installation
- Validate DB connectivity — `db.Connect()` handles this with retry and fail-fast
- Log the current schema version and number of pending migrations
- After migrations complete, log the new schema version

## Rules

- Never modify an already-applied migration file — create a new migration instead
- `down` scripts must exist but are never run automatically in production
- Every DB schema change (table, column, index, constraint) requires a migration — no exceptions
- Migration files are committed to the repo alongside the feature that requires them
- Sensitive data transformations in migrations must be done carefully — log progress for long-running migrations
- Every foreign key gets an index that starts with its columns, in the same module's migrations. The only exception is `ON DELETE SET NULL` to `users`, and a table service accounts fill in bulk indexes those too. `TestForeignKeysIndexed` (`apps/depotex/backend/cmd/server`) fails otherwise
- A column that names a user is `bigint REFERENCES users(id)` (`ON DELETE SET NULL` unless the row is the person's own), and code writes NULL for the system, never 0
- A query that reads `depot_repositories` skips deleted ones (`deleted_at IS NULL`); `TestQueriesSkipDeletedRepositories` fails otherwise
- A text column whose values are a fixed Go set gets a `CHECK (col IN (…))` and a row in `TestCheckConstraintsMatchGo`; sets that grow with features (formats, origins, kinds, reasons, roles) get none
- An index on a table that grows with use (artifacts, components, SBOMs, audit logs) is built or dropped with `CONCURRENTLY`, as the only statement in its file: golang-migrate sends a file as one batch, and a batch runs in a transaction, where `CONCURRENTLY` fails
