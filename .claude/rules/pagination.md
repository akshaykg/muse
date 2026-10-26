---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
  - "libs/api-client/**"
  - "libs/shared-types/**"
---

# Pagination Rule

All list-returning API endpoints must use cursor-based pagination via `libs/go-common/pagination`. Simple endpoints returning a single item or a small fixed set are exempt.

## Query Parameters

- `cursor` — opaque encoded token representing the current position
- `limit` — number of items to return (default: `PAGINATION_DEFAULT_LIMIT`, max: `PAGINATION_MAX_LIMIT`)

## Request Parsing

Use `pagination.FromRequest(r)` to extract and validate cursor + limit from the HTTP request:

```go
page, err := pagination.FromRequest(r)
if err != nil {
    // return 400 — bad cursor or invalid limit
}
```

## Response Shape

```json
{
  "data": [...],
  "pagination": {
    "nextCursor": "eyJ2Ijp...",
    "prevCursor": "eyJ2Ijp...",
    "hasNext": true,
    "hasPrev": false,
    "limit": 20
  }
}
```

Use `pagination.BuildPageInfo()` to construct the response metadata:

```go
info := pagination.BuildPageInfo(len(rows), page.Limit, firstValues, lastValues, page)
if len(rows) > page.Limit {
    rows = rows[:page.Limit]
}
```

- When no results: return `data: []` with `hasNext: false`, `hasPrev: false` — never return nulls

## Database Layer

- Repositories fetch `page.Limit + 1` rows to detect whether a next page exists
- Queries must use cursor-based filtering: `WHERE (col1, col2) < ($1, $2) LIMIT n`
- `OFFSET` is forbidden — no full table scans
- No fetching all records then filtering in memory

## Cursor Encoding

- Cursors are encoded/decoded via `pagination.EncodeCursor()` / `pagination.DecodeCursor()`
- Cursors are base64url-encoded JSON containing sort key values and direction
- If `PAGINATION_CURSOR_SECRET` is set, cursors are HMAC-SHA256 signed to prevent tampering
- Never expose raw DB IDs or offsets — always use the pagination package

## Sort Order

- All paginated queries must have a deterministic, stable sort order (e.g. `created_at DESC, id DESC`)
- Unstable sort breaks cursor pagination

## Error Handling

- Invalid or malformed cursor must return HTTP 400 with a clear error message
- `pagination.FromRequest()` returns an error for bad cursors — handlers should return 400
- Never silently return wrong data on bad cursor input
