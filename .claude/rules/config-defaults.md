---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
  - "apps/*/src/**"
  - ".env.example"
  - "apps/*/next.config.*"
---

# Configuration & Default Parameters Rule

All default values must be overridable via environment variables. Hardcoded values are only acceptable as fallback defaults — never as the sole source of truth. The exception is a value every node must share (below): it is never env-only.

## Principles

- No magic numbers or hardcoded defaults buried in business logic
- Every configurable default has a corresponding environment variable, except a value every node must share that is kept as a code constant (below)
- Config is loaded once at startup and injected where needed — not read inline across the codebase
- Both Go backend and Node/Next.js frontend must follow this rule

## Values Every Node Must Share

Env vars are per node (`cluster-compatibility.md`). A value that must be the same on every node — a limit an upload is checked against, a TTL a cleanup job applies, what a client is told — is one of:

- **A code constant**, with a comment saying why it is fixed. Where admins need to change it, a Postgres setting overrides it (Settings, read on every node).
- **A Postgres setting** whose env var is only the default until an admin saves the setting.

Never env-only: two nodes started with different values answer the same request differently, and a scheduled job applies whichever value its node has. When something must last past the request (an upload session, a reservation), store its own expiry with the row (`expires_at`) instead of computing it from a node's value later. Existing env-only values are listed in `doc/internal-dev-doc/known-gaps/README.md`. A value that differs by machine on purpose (a timeout that depends on the node's CPU) stays per node.

## Environment Variables

- Use descriptive, namespaced names (e.g. `PAGINATION_DEFAULT_LIMIT`, `PAGINATION_MAX_LIMIT`, `REDIS_CONNECT_TIMEOUT`)
- All env vars must be documented in a `.env.example` file at the repo root with descriptions and example values
- Sensitive values (secrets, keys) must never have defaults — they must be explicitly set or the app fails to start

## Startup Validation

- On startup, validate all required env vars are present and have valid values
- If an env var is set to an invalid value (e.g. non-numeric for a number field), fail fast with a clear, descriptive error message
- Never silently fall back to a default when an explicitly set value is invalid

## Example Pattern (Go)

```go
defaultLimit := getEnvInt("PAGINATION_DEFAULT_LIMIT", 20)
maxLimit := getEnvInt("PAGINATION_MAX_LIMIT", 100)
```

## Logger Environment Variables

The `libs/go-common/logger` package reads these at startup. See the logging rule for full details.

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Global log level: debug, info, warn, error, fatal |
| `LOG_LEVEL_{PACKAGE}` | inherits global | Per-package override (e.g. `LOG_LEVEL_AUTH=debug`) |
| `APP_ENV` | `production` | `development` enables human-readable console output |
| `LOG_CALLER` | `false` | `true` or `1` to include file:line in every entry |
| `LOG_SAMPLE_RATE` | `0` | Log 1-in-N entries; 0 = disabled |
| `LOG_REDACT_ENABLED` | `true` | Automatic secret scrubbing in output |

Invalid values warn to stderr and fall back to defaults — the logger never fails to start.

## Database Environment Variables

The `libs/go-common/db` package reads these at startup. See the data-access rule for full details.

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | **(required)** | Postgres connection string. Pool tuning via query params. |
| `DB_CONNECT_TIMEOUT` | `30s` | Total time to retry connecting on startup |
| `DB_SLOW_QUERY_THRESHOLD` | `500ms` | Log queries slower than this at WARN level. `0` = disabled. |

`DATABASE_URL` has no default — the app panics on startup if it is missing. Invalid duration values for the other two also cause a startup panic with a clear error message.

## Pagination Environment Variables

The `libs/go-common/pagination` package reads these at startup. See the pagination rule for full details.

| Variable | Default | Description |
|----------|---------|-------------|
| `PAGINATION_DEFAULT_LIMIT` | `20` | Default items per page |
| `PAGINATION_MAX_LIMIT` | `100` | Maximum items per page |
| `PAGINATION_CURSOR_SECRET` | *(empty)* | HMAC-SHA256 key for cursor signing. Recommended in production. |

Invalid limit values cause a startup panic. If `PAGINATION_CURSOR_SECRET` is not set, cursors are unsigned (acceptable in development, not recommended in production).

## License Environment Variables

The `libs/go-common/license` package reads these at startup. See the licensing rule for full details.

| Variable | Default | Description |
|----------|---------|-------------|
| `LICENSE_FILE_PATH` | *(none)* | Path to license.json. If unset, app enters setup mode. |

The public key is typically embedded at build time via `//go:embed`, not via env var.

## Cache Environment Variables

The `libs/go-common/cache` package reads these at startup. See the cache package documentation for full details.

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | **(required)** | Redis connection string |
| `REDIS_CONNECT_TIMEOUT` | `10s` | Total time to retry connecting on startup |
| `REDIS_KEY_PREFIX` | *(empty)* | Optional key namespace prefix (e.g. `depotex:`) |

`REDIS_URL` has no default — the app panics on startup if it is missing.

## Example Pattern (Node/Next.js)

```ts
const DEFAULT_LIMIT = parseInt(process.env.PAGINATION_DEFAULT_LIMIT ?? '20', 10)
const MAX_LIMIT = parseInt(process.env.PAGINATION_MAX_LIMIT ?? '100', 10)
```
