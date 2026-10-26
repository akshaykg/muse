---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
  - "libs/api-client/**"
  - "libs/shared-types/**"
---

# Error Response Standard

All API errors must follow a consistent response shape via `libs/go-common/errors`. No endpoint should return ad-hoc error formats, plain strings, or raw stack traces.

## Standard Error Shape

```json
{
  "error": "error_code",
  "reason": "specific_cause",
  "message": "Human-readable description of what went wrong",
  "code": 400,
  "details": {}
}

```

- `error` — machine-readable snake_case error code (e.g. `validation_error`, `not_found`, `forbidden`)
- `message` — human-readable message safe to display to end users
- `code` — HTTP status code (mirrors the HTTP response status)
- `details` — optional object with additional context (e.g. field-level validation errors), omitted if not applicable
- `reason` — optional stable snake_case cause more specific than `error` (`name_taken`, `account_locked`). Omitted when `error` says it all

## Reasons (what the UI shows)

The UI never shows `message`: it is English, for logs and API consumers. The frontend picks translated text by `reason`, then by `error`, and fills in `details` (see the `i18n` rule).

- Any error a user can fix, or that needs a specific explanation, gets a `reason` via `.WithReason("…")`. Values its text needs go in `details` via `.WithDetail(key, value)` (`max`, `name`, `retry_after_seconds`, `max_size_bytes`).
- A reason is an API contract: never rename or reuse one for a different cause. Add English text for every new reason in the owning feature's catalog (`<namespace>.reasons.<reason>`). A test (`apps/core-frontend/src/__tests__/api-error-message.test.ts`) fails when a reason sent by the backend has no text.
- Classify errors with sentinel errors and typed errors (`errors.Is` / `errors.As`), never by matching message strings.
- Never put the underlying error (driver messages, hosts, file paths from the server) in `message` or `details`. Log it; send the reason.

## Error Builders

All errors must be constructed via `libs/go-common/errors` builders:

```go
errors.Validation("Request validation failed", details)   // 400
errors.Unauthorized("Not authenticated")                   // 401
errors.LicenseRequired("pro", "standard")                  // 402
errors.Forbidden("You do not have permission")             // 403
errors.NotFound("user", userID)                            // 404
errors.Conflict("Email already exists")                    // 409
errors.Unprocessable("Cannot delete active subscription")  // 422
errors.RateLimited("Too many requests")                    // 429
errors.Internal(err)                                       // 500
```

## Writing Error Responses

Use `errors.Write(w, err)` in handlers — it auto-detects `*AppError`, sets the correct HTTP status, and writes the JSON body:

```go
if err != nil {
    errors.Write(w, err)
    return
}
```

If `err` is not an `*AppError`, `Write` returns a generic 500 — real error details are never exposed.

## Common Error Codes

| HTTP Status | error code | When to use |
|-------------|----------------------|-------------|
| 400 | `validation_error` | Invalid request body or params |
| 401 | `unauthorized` | Not authenticated |
| 402 | `license_required` | Feature requires higher license tier |
| 403 | `forbidden` | Authenticated but lacks permission |
| 404 | `not_found` | Resource does not exist |
| 409 | `conflict` | State conflict (e.g. duplicate) |
| 422 | `unprocessable` | Semantically invalid request |
| 429 | `rate_limited` | Too many requests |
| 500 | `internal_error` | Unexpected server error |

## Error Checking

Use helpers to check error types in service/repository code:

```go
if errors.IsNotFound(err) { ... }
if errors.IsConflict(err) { ... }
status := errors.StatusCode(err)
```

These work through `fmt.Errorf("wrap: %w", err)` wrapping via `errors.As`.

## Rules

- Never leak stack traces, internal error messages, or DB errors to the client
- Internal errors (500) must log the full error via `logger.FromContext(ctx).Error().Err(err)` but return only a generic message to the client
- Validation errors should include field-level details in the `details` field:

```json
{
  "error": "validation_error",
  "message": "Request validation failed",
  "code": 400,
  "details": {
    "fields": [
      { "field": "email", "message": "must be a valid email address" },
      { "field": "name", "message": "is required" }
    ]
  }
}
```

- All errors must be constructed via `libs/go-common/errors` builders — no ad-hoc error construction
- All error responses must be written via `errors.Write(w, err)` — no manual status code + JSON encoding
- HTTP status code in the response body must always match the actual HTTP response status
