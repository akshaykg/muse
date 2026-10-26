---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
---

# Application Logging Rule

All application logging must use the shared `libs/go-common/logger` package. No `fmt.Println`, `log.Print`, raw `zerolog` imports, or ad-hoc logging anywhere in the codebase.

**Logs are always English.** Log messages, error strings (`fmt.Errorf`, `AppError.Message`) and field names are written in English and never translated: no catalog lookups, no user or instance locale in the logging path. Logs are for operators and support; one language keeps them searchable, matchable by alert rules and readable by anyone debugging any installation. Translation happens only in the UI (see `i18n.md`).

## Go Backend — `libs/go-common/logger`

The logger package wraps zerolog and provides a single, consistent logging setup across all Go apps in the monorepo.

### Initialization

Call `logger.Init()` once at startup in `main.go`:

```go
import "libs/go-common/logger"

func main() {
    rootLogger := logger.Init()
    rootLogger.Info().Msg("server starting")
}
```

Log files and export are built in (see Log Files below); don't add other writers.

### Named Loggers

Each package, module and plugin logs through a named logger, so administrators can change its level at runtime (Settings → Logging, temporary "debug for 30 minutes" included):

```go
var log = logger.Package("billing")   // shared library package; LOG_LEVEL_BILLING
log := logger.Module("identity")      // platform/product module (in its constructor)
log := logger.Plugin("acme")          // plugin; component "plugin:acme"
```

Never build a module logger with `deps.Log.With()…` — it can't be adjusted. Use the named logger for startup/init messages where there is no request context.

### Log Files

Besides stderr, logs can go to rotating files on the server's disk (`LOG_FILE_DIR`; pattern, format, rotation and retention in Settings → Logging). The directory is an operator setting only; nothing a user sends may choose a file path.

### Request-Scoped Logging

In HTTP middleware, attach the logger to context with request fields:

```go
ctx = logger.WithContext(r.Context(), reqLogger)
ctx = logger.WithFields(ctx, map[string]string{
    logger.FieldRequestID: requestID,
    logger.FieldUserID:    userID,
    logger.FieldTenantID:  tenantID,
})
```

In services and business logic, always use the context logger:

```go
logger.FromContext(ctx).Info().Str("email", email).Msg("user created")
logger.FromContext(ctx).Error().Err(err).Msg("failed to create user")
```

### Log Levels

| Level | When to use |
|-------|-------------|
| `DEBUG` | Detailed dev/troubleshooting info, never in production by default |
| `INFO` | Normal operational events (startup, requests, state changes) |
| `WARN` | Unexpected but recoverable situations |
| `ERROR` | Failures that need attention but don't crash the process |
| `FATAL` | Unrecoverable errors — logs then exits |

### Redaction

Never log secrets, tokens, passwords, or PII — even at DEBUG level. Use the logger package's redaction helpers:

```go
// Full redaction
log.Info().Str("token", logger.Redact(token)).Msg("auth")
// Output: {"token":"[REDACTED]"}

// Partial masking (keeps enough to identify the value type)
log.Info().Str("email", logger.Mask(email)).Msg("user created")
// Output: {"email":"ak***@example.com"}
```

The `SafeWriter` automatically scrubs known secret patterns (JWTs, Bearer tokens, API keys, AWS keys) from all log output as a safety net. Enabled by default via `LOG_REDACT_ENABLED`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Global log level: debug, info, warn, error, fatal |
| `LOG_LEVEL_{PACKAGE}` | inherits global | Per-package override (e.g. `LOG_LEVEL_AUTH=debug`) |
| `APP_ENV` | `production` | `development` enables human-readable console output |
| `LOG_CALLER` | `false` | `true` or `1` to include file:line in every entry |
| `LOG_SAMPLE_RATE` | `0` | Log 1-in-N entries; 0 = disabled |
| `LOG_REDACT_ENABLED` | `true` | Automatic secret scrubbing in output |
| `LOG_FILE_DIR` | `./data/logs` | Where this server writes log files |
| `LOG_FILE_ENABLED` | `true` | Log file on until changed in Settings → Logging |

### Output Format

- Production: structured JSON to stderr (one JSON object per line)
- Development (`APP_ENV=development`): human-readable console output to stderr

### Graceful Failure

- If `Init()` panics, a minimal fallback logger is installed — logging never silently stops
- If the `SafeWriter` encounters pathological input, it writes the original line unredacted rather than crashing
- Payloads larger than 1MB bypass redaction to avoid OOM

### Rules

- Every Go app must call `logger.Init()` at startup — no direct zerolog usage
- Use `logger.Package("name")` for package-level loggers — no global `log` package
- Use `logger.FromContext(ctx)` in request handlers and services — always include request context
- Errors must be logged with `.Err(err)` — never just the message string
- Use `logger.Redact()` or `logger.Mask()` for any field that could contain sensitive data
- Audit logs are separate — they always write regardless of `LOG_LEVEL` (see audit-logging rule)

## Node/Next.js Frontend — Server Side Only

- Server-side logging (API routes, middleware, SSR) uses a structured logger (e.g. `pino`)
- Log level controlled via `LOG_LEVEL` env var, same levels as backend
- Client-side: `console.log/warn/error` is acceptable for debug purposes only — never in production builds (stripped via build config)
- No sensitive data in any server-side logs
