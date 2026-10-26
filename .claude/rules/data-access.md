---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
  - "libs/platform/sqlc.yaml"
---

# Data Access Rule

All database access must go through a repository abstraction layer. No direct DB queries in handlers or business logic.

## Stack

- **Database**: PostgreSQL only
- **Driver**: `pgx` via `libs/go-common/db` — shared connection management with retry, tracing, and transactions
- **Query generation**: `sqlc` — write raw SQL, get type-safe Go code generated
- **No ORMs** — `gorm` and similar are forbidden

## Architecture

```
Handler → Service → Repository (interface) → sqlc-generated Postgres implementation
                ↕
        libs/go-common/db (Connect, RunInTx, Migrate)
```

- Handlers call services only — never repositories directly
- Services call repository interfaces — never `pgx` or SQL directly
- Repository interfaces are defined in the domain/service layer
- Postgres implementations live in `backend/internal/repository/postgres/`
- `sqlc`-generated code lives in `backend/internal/db/` — never hand-edited
- Connection pool is created via `db.Connect()` at startup and injected into repositories

## Connection Setup

All apps must use `libs/go-common/db` for database connections:

```go
cfg := db.ConfigFromEnv()
pool, err := db.Connect(ctx, cfg)  // retries with backoff until DB is ready
defer pool.Close()
```

Pool tuning is done via `DATABASE_URL` query params — no separate env vars:

```
DATABASE_URL=postgres://user:pass@host/db?pool_max_conns=20&pool_min_conns=5
```

## Repository Pattern

Each resource has:
1. A repository interface defining the contract
2. A Postgres implementation using `sqlc`-generated queries

```go
// Interface (domain layer) — accepts DBTX so it works with both pool and tx
type UserRepository interface {
    GetByID(ctx context.Context, db DBTX, id uuid.UUID) (*User, error)
    List(ctx context.Context, db DBTX, params ListParams) ([]*User, Cursor, error)
    Create(ctx context.Context, db DBTX, params CreateUserParams) (*User, error)
    Update(ctx context.Context, db DBTX, id uuid.UUID, params UpdateUserParams) (*User, error)
    Delete(ctx context.Context, db DBTX, id uuid.UUID) error
}

// Implementation (repository layer)
type postgresUserRepository struct{}
```

## Transactions

Transactions must be managed at the service layer using `db.RunInTx()`:

```go
func (s *UserService) CreateWithProfile(ctx context.Context, params CreateParams) error {
    return db.RunInTx(ctx, s.pool, nil, func(tx pgx.Tx) error {
        user, err := s.userRepo.Create(ctx, tx, params.User)
        if err != nil {
            return err
        }
        return s.profileRepo.Create(ctx, tx, user.ID, params.Profile)
    })
}
```

`RunInTx` handles commit, rollback on error, and panic recovery automatically. Pass `*pgx.TxOptions` for non-default isolation levels (e.g. `pgx.Serializable` for financial operations).

## sqlc

- All SQL queries are written in `backend/internal/db/queries/` as `.sql` files
- `sqlc generate` produces type-safe Go code — never edit generated files manually
- Queries must be Postgres-specific — use Postgres features freely (`UUID`, `JSONB`, `ARRAY`, CTEs, etc.)
- `sqlc.yaml` config lives at `backend/sqlc.yaml`

## Rules

- No raw SQL strings outside of `sqlc` query files
- No `database/sql` usage — use `pgx` exclusively via `libs/go-common/db`
- All database connections must be created via `db.Connect()` — no direct `pgxpool.New()` calls
- Repository interfaces must be used in service layer — never concrete implementations
- All DB calls must accept and propagate `context.Context` for cancellation and tracing
- Transactions must use `db.RunInTx()` — no manual `pool.Begin()` / `tx.Commit()` / `tx.Rollback()`
- Pagination queries must follow the cursor-based pagination rule — no `OFFSET` in any query
