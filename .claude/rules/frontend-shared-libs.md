---
paths:
  - "apps/*/src/**"
  - "libs/ui-components/**"
  - "libs/api-client/**"
  - "libs/shared-types/**"
---

# Frontend Shared Libraries Rule

All frontend apps share types, components, and API client code through dedicated libraries under `libs/`. No duplication of types, API calls, or UI components across apps.

## Libraries

### `libs/shared-types/` — API Contract Types

TypeScript types that mirror the Go backend's API request/response shapes. Single source of truth for the frontend-backend contract.

```
libs/shared-types/src/
├── api/
│   ├── errors.ts          # AppError (mirrors libs/go-common/errors)
│   ├── pagination.ts      # PageInfo, PaginatedResponse<T>
│   └── responses.ts       # Common response wrappers
├── models/                # One file per domain entity
│   ├── user.ts
│   ├── ticket.ts
│   └── license.ts
├── enums.ts               # Tiers, roles, permissions, statuses
└── index.ts
```

Rules:
- Every Go API response struct must have a matching TypeScript type in `shared-types`
- Types are kept in sync manually or via code generation — never duplicated across apps
- All types are exported as named exports — no default exports
- Field names must match the Go JSON tags exactly (`camelCase` in JSON = `camelCase` in TypeScript)

### `libs/api-client/` — HTTP Client

Shared fetch wrapper used by all frontend apps to call the Go backend.

```
libs/api-client/src/
├── client.ts        # Fetch wrapper — base URL, auth, timeout, JSON handling
├── errors.ts        # AppError parsing, 401/402/403 handling
└── index.ts
```

Rules:
- All API calls must go through `api-client` — no raw `fetch` in components
- Handles authentication (token injection) automatically
- Parses error responses into typed `AppError` objects
- Handles HTTP 401 (redirect to login), 402 (upgrade prompt), 403 (permission denied)
- Handles pagination (passes cursor/limit, returns typed `PaginatedResponse<T>`)
- Request timeout configurable via environment variable

### `libs/ui-components/` — Shared React Components

Reusable React components used across all frontend apps.

```
libs/ui-components/src/
├── Button.tsx
├── Skeleton.tsx
├── Modal.tsx
├── UpgradePrompt.tsx
├── ErrorBoundary.tsx
└── index.ts
```

Rules:
- All shared components live here — app-specific components stay in the app
- Components must use CSS variables for colors — no hardcoded values (see theming rule)
- Every component must have TypeScript props interface — no `any`
- Components must be accessible (WCAG AA)
- Components must be responsive (mobile-first)

## Dependency Direction

```
apps/* → libs/api-client → libs/shared-types
apps/* → libs/ui-components
apps/* → libs/shared-types

libs/api-client → libs/shared-types
libs/ui-components → libs/shared-types (for prop types)
libs/shared-types → (nothing)
```

- Apps import from libs — never from other apps
- `api-client` imports from `shared-types` for request/response types
- `ui-components` may import from `shared-types` for prop types
- `shared-types` has no dependencies — it's pure type definitions

## Type Sync with Go Backend

When a Go API struct changes:
1. Update the Go struct
2. Update the matching TypeScript type in `libs/shared-types/`
3. Both changes must be in the same PR — never let them drift

Types that must stay in sync:
- `AppError` ↔ `libs/go-common/errors.AppError`
- `PageInfo` ↔ `libs/go-common/pagination.PageInfo`
- `LicenseInfo` ↔ `libs/go-common/license.LicenseInfo`
- All API request/response DTOs
