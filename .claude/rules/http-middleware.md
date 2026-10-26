---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
---

# HTTP Middleware Rule

All HTTP services must use the shared middleware stack from `libs/go-common/middleware`. App-specific middleware (auth, RBAC) is built on top of the shared stack.

## Middleware Chain Order

Every request passes through middleware in this exact order:

```
Request arrives
    │
    ├─ 1. Recovery              ← libs/go-common/middleware     (catch panics)
    ├─ 2. Request ID            ← libs/go-common/middleware     (generate/extract X-Request-ID)
    ├─ 3. Request Logger        ← libs/go-common/middleware     (attach logger to context, log request)
    ├─ 4. CORS                  ← libs/go-common/middleware     (handle preflight, set headers)
    ├─ 5. Rate Limiting         ← libs/go-common/middleware     (per-user/per-IP throttle)
    ├─ 6. License Check         ← libs/go-common/license        (setup/expired/valid state)
    ├─ 7. Authentication        ← libs/platform/auth, apitoken   (validate token, extract user)
    ├─ 8. RBAC                  ← module handlers               (check permissions)
    │
    ▼
    Handler
```

Steps 1–5 are shared. Steps 6–8 are app-specific but follow the same `func(http.Handler) http.Handler` pattern.

## Shared Middleware (libs/go-common/middleware)

### Recovery

Must be the outermost middleware. Catches panics, logs the error, returns 500. Never exposes panic details to the client.

```go
middleware.Recovery(next)
```

- Re-panics `http.ErrAbortHandler` (Go's signal to abort the connection)
- If headers were already sent, logs only — does not attempt to write 500

### Request ID

Generates a unique ID per request or extracts from `X-Request-ID` header (for distributed tracing). Sets the response header.

```go
middleware.RequestID(next)
```

- Client-provided IDs longer than 64 characters are replaced with a generated ID
- Use `middleware.GetRequestID(ctx)` to access the ID in handlers/services

### Request Logger

Attaches a logger with `request_id` to the context and logs the completed request.

```go
middleware.RequestLogger(next)
```

- Logs: method, path, status, bytes, duration
- 5xx → ERROR level, 4xx → WARN level, rest → INFO level
- Does NOT log query parameters — prevents leaking sensitive data in URLs
- All downstream code uses `logger.FromContext(ctx)` and automatically gets the request_id

### CORS

Handles preflight requests and sets CORS headers. App provides the allowed origins.

```go
middleware.CORS(middleware.CORSOptions{
    AllowedOrigins:   []string{"https://app.example.com"},
    AllowCredentials: true,
})(next)
```

- Skips CORS for WebSocket upgrade requests
- Echoes actual origin (not `*`) when credentials are enabled
- Preflight responses are cached for 24 hours by default

### Rate Limiting

Enforces request rate limits on a `*ratelimit.Limiter` (`libs/go-common/ratelimit`, GCRA): Redis when available, in-memory per node otherwise. App provides the rules (who is counted, in which route class, at what policy).

```go
middleware.RateLimit(middleware.RateLimitOptions{
    Limiter: limiter, // one per process, built at wiring time
    Rules: func(r *http.Request) []ratelimit.Rule {
        return []ratelimit.Rule{{Class: "api", Key: "user:" + getUserID(r), Policy: ratelimit.PerMinute(100)}}
    },
})(next)
```

- Redis down at runtime → automatic fallback to in-memory (logged at WARN once per transition)
- Sets `RateLimit-Policy`, `RateLimit`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `Retry-After` on 429
- No rules for a request → it is not rate limited (use for health checks)
- `OnLimited` is called for each budget a request goes over (refused, or let through by a dry run); the kernel records it in the activity view
- The process has one `*ratelimit.Limiter`, built in the kernel and passed to modules as `module.Deps.Limiter`; never build another for request budgets
- Budgets are never hard-coded or read from env at request time: the kernel's rules read `libs/platform/ratelimits` (`Service.Snapshot()`: Settings → Security → Rate limits and overrides; env vars are only its defaults). A handler that knows its caller only after auth (MCP servers) takes from its budgets itself with `Limiter.Take` and `middleware.SetRateLimitHeaders`

## App-Specific Middleware

### License Check (libs/go-common/license)

Already built. See `licensing.md`.

```go
license.NewMiddleware(info, license.MiddlewareOptions{
    SetupPaths:   []string{"/setup", "/api/setup"},
    ExpiredPaths: []string{"/api/health", "/api/auth/login", "/api/admin/license"},
})
```

### Authentication (app-specific — to be implemented)

Session auth lives in `libs/platform/auth` (`AuthMiddleware`, `CSRFMiddleware`) and token auth in `libs/platform/apitoken`; the kernel mounts both. Any new auth middleware must:

- Validate the token (JWT, session cookie, API key — app decides the mechanism)
- Extract the user identity and attach to context
- Return `errors.Unauthorized("Not authenticated")` for invalid/missing tokens
- Skip auth for public endpoints (login, registration, health check)
- Run AFTER license check — an expired license should block before auth is checked

```go
// Pattern for app-specific auth middleware
func Auth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := extractToken(r)  // from cookie, header, etc.
        user, err := validateToken(token)
        if err != nil {
            errors.Write(w, errors.Unauthorized("Not authenticated"))
            return
        }
        ctx := withUser(r.Context(), user)
        ctx = logger.WithFields(ctx, map[string]string{
            logger.FieldUserID:   user.ID,
            logger.FieldTenantID: user.TenantID,
        })
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### RBAC (app-specific — to be implemented)

RBAC is currently checked in each module's handlers (central RBAC is planned — see known gaps). Any RBAC middleware must:

- Check the user's permissions against the required permission for the endpoint
- Return `errors.Forbidden("You do not have permission")` if denied
- Run AFTER authentication — user must be identified before permissions are checked
- Support both global and scoped roles

```go
// Pattern for app-specific RBAC middleware
func RequirePermission(permission string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            user := getUserFromContext(r.Context())
            if !user.HasPermission(permission) {
                errors.Write(w, errors.Forbidden("You do not have permission"))
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

## Full Wiring Example

```go
func main() {
    logger.Init()
    rdb, _ := cache.Connect(ctx, cache.ConfigFromEnv())
    licenseInfo := license.Load(licenseOpts)

    router := http.NewServeMux()
    // ... register routes ...

    // Build middleware chain (outermost first)
    handler := middleware.Recovery(
        middleware.RequestID(
            middleware.RequestLogger(
                middleware.CORS(middleware.CORSOptions{
                    AllowedOrigins: []string{os.Getenv("CORS_ORIGIN")},
                    AllowCredentials: true,
                })(
                    middleware.RateLimit(middleware.RateLimitOptions{
                        Limiter: limiter,
                        Rules:   middleware.PerIP("flood", ratelimit.PerMinute(100)),
                    })(
                        license.NewMiddleware(licenseInfo, licenseOpts)(
                            authMiddleware(
                                router,
                            ),
                        ),
                    ),
                ),
            ),
        ),
    )

    http.ListenAndServe(":8080", handler)
}
```

## Rules

- Every Go HTTP service must use `middleware.Recovery` as the outermost middleware — no exceptions
- Every service must use `middleware.RequestID` and `middleware.RequestLogger` — all requests must be traceable
- The middleware chain order (recovery → request ID → logger → CORS → rate limit → license → auth → RBAC) must be followed — reordering breaks security guarantees
- Auth middleware must attach `user_id` and `tenant_id` to the logger context via `logger.WithFields`
- Rate limit rule keys must never contain sensitive data (passwords, tokens) — the key is logged
- CORS `AllowedOrigins` must not be `["*"]` in production — use explicit origins
- All middleware must follow the `func(http.Handler) http.Handler` pattern for composability
