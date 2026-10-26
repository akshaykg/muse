---
paths:
  - "apps/*/**/*.go"
  - "libs/platform/**/*.go"
---

# Go Common Library Usage Rule

All Go backend code MUST use the shared libraries from `libs/go-common/` for infrastructure concerns. No reimplementation of functionality that already exists in the shared library.

## Available Packages

| Package | Use for |
|---------|---------|
| `libs/go-common/middleware` | HTTP middleware (recovery, request ID, logging, CORS, rate limiting) |
| `libs/go-common/ratelimit` | Rate limit engine (GCRA, Redis with per-node fallback) behind `middleware.RateLimit`; `Activity` counts limited requests per hour and the top keys |
| `libs/go-common/errors` | Error builders and HTTP error responses |
| `libs/go-common/pagination` | Cursor-based pagination (parsing, encoding, page info) |
| `libs/go-common/logger` | Structured logging (zerolog wrapper) |
| `libs/go-common/db` | Database connection, migrations, transactions |
| `libs/go-common/cache` | Redis connection and helpers |
| `libs/go-common/gencache` | Per-server read cache for hot-path configuration reads, kept fresh by Postgres triggers (`read-cache.md`) |
| `libs/go-common/license` | License loading, verification, tier checks |
| `libs/go-common/storage` | File/object storage abstraction |
| `libs/go-common/mail` | Sending email (`Sender`, SMTP, Amazon SES API); queue and settings are the platform `mail` module |
| `libs/go-common/awsauth` | AWS SDK config for Depotex's own AWS clients: default credential chain or keys, optional assumed role (S3, SES) |
| `libs/go-common/events` | Event catalog: define events (`events.Define`) and raise them (`events.Before`/`After`) |
| `libs/go-common/hooks` | The engine that delivers events to subscribers (register handlers; don't call `RunPre`/`RunPost` directly) |
| `libs/go-common/indexing` | Search index management |
| `libs/go-common/httpclient` | Clients that stream downloads from remote servers: HTTP/2 health checks and the stall guard (`New` for tools, `CheckHTTP2` + `GuardStalls` for clients built elsewhere) |
| `libs/go-common/metrics` | Prometheus metrics: define counters, gauges and histograms (`metrics.NewCounterVec`…); no user, token or address labels; the kernel serves `/metrics` |

## Required Usage

### Middleware

Use `libs/go-common/middleware` for all generic HTTP concerns:

```go
import "libs/go-common/middleware"

// ✅ Good — use the shared limiter with per-request rules
middleware.RateLimit(middleware.RateLimitOptions{
    Limiter: limiter, // *ratelimit.Limiter from the composition root
    Rules: func(r *http.Request) []ratelimit.Rule {
        return []ratelimit.Rule{{Class: "api", Key: extractKey(r), Policy: ratelimit.PerMinute(dynamicLimit(r))}}
    },
})

// ❌ Bad — reimplementing rate limiting with custom Redis INCR/EXPIRE
func customRateLimit(cache *redis.Client) func(http.Handler) http.Handler { ... }
```

### Errors

Use `libs/go-common/errors` for all error responses:

```go
import "libs/go-common/errors"

// ✅ Good
errors.Write(w, errors.Validation("Invalid input", details))
errors.Write(w, errors.Forbidden("Not allowed"))
errors.Write(w, errors.NotFound("token", id))

// ❌ Bad — manual JSON error encoding
w.WriteHeader(400)
json.NewEncoder(w).Encode(map[string]string{"error": "bad request"})
```

### Pagination

Use `libs/go-common/pagination` for all list endpoints:

```go
import "libs/go-common/pagination"

// ✅ Good
page, err := pagination.FromRequest(r)
info := pagination.BuildPageInfo(totalFetched, page.Limit, firstValues, lastValues, page)

// ❌ Bad — manual cursor parsing and page info construction
```

### Logging

Use `libs/go-common/logger` for all logging:

```go
import "libs/go-common/logger"

// ✅ Good
var log = logger.Package("apitoken")
logger.FromContext(ctx).Info().Str("token_id", id).Msg("token created")

// ❌ Bad — direct zerolog or fmt.Println
```

## When to Extend the Shared Library

If you need functionality that is:
- Generic (not tied to a specific feature's business logic)
- Reusable across multiple apps or packages
- An extension of existing shared functionality

Then **ask the user** before implementing it inline. Propose extending `libs/go-common/` instead.

### Examples of When to Extend

- Adding a new kind of budget or store to the rate limiter → extend `ratelimit/`
- Adding a new error builder (e.g., `errors.PaymentRequired()`) → extend `errors/errors.go`
- Adding cursor signing/verification → extend `pagination/`
- Adding a new storage backend → extend `storage/`

### How to Extend

1. Add the new functionality to the appropriate package in `libs/go-common/`
2. Maintain backward compatibility — existing callers must not break
3. Add tests in the same package
4. Use the extension from the app code via the normal import path

## What Stays App-Specific

These belong in `libs/platform/*` or a product's own packages — NOT in `libs/go-common`:

- **Authentication logic** — session validation, token verification, user lookup
- **Business rules** — permission checks, policy enforcement, domain validation
- **Feature handlers** — HTTP route handlers with request/response parsing
- **Domain models** — feature-specific structs and interfaces
- **Service layer** — orchestration of repositories, external calls, audit logging

## Decision Checklist

Before writing infrastructure code in an app:

1. Does `libs/go-common/` already have this? → **Use it**
2. Is it generic enough for other apps? → **Propose extending the shared lib**
3. Is it tied to this feature's domain logic? → **Keep it app-specific**

## Enforcement

- All new Go backend code MUST check `libs/go-common/` before reimplementing infrastructure
- If shared functionality is missing a needed option, extend the shared lib rather than reimplementing
- Code reviews MUST flag duplicated infrastructure that belongs in the shared library
- When extending `libs/go-common/`, ensure backward compatibility with existing callers
