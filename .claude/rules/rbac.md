---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
---

# RBAC (Role-Based Access Control) Rule

Every API endpoint and UI feature must be gated by roles and permissions. No endpoint or feature should be accessible without an explicit permission check.

## Role Types

Roles are flat (non-hierarchical) but fall into two scopes:

- **Global roles** — apply system-wide regardless of resource context (e.g. `super_admin`, `billing_admin`)
- **Scoped roles** — apply within a specific resource context (e.g. `org:admin`, `project:viewer`, `team:editor`)

## Backend Enforcement

- Every API endpoint must declare the required permission(s) explicitly
- Permission checks must happen at the handler/middleware level — not buried in business logic
- Both global and scoped roles must be evaluated — a user may have access via either
- Deny by default — if no permission is explicitly granted, access is denied

## Frontend Behavior

- UI elements tied to permissions should reflect the user's access state
- When a user lacks permission: return a clear error response (HTTP 403) — no silent failures
- Error responses must include enough context for the frontend to show an appropriate message

## Permission Naming Convention

Use a consistent `resource:action` format:
- Examples: `users:read`, `users:write`, `projects:delete`, `billing:manage`
- Scoped permissions include the scope context at evaluation time, not in the name itself

## New Features

- Every new API endpoint must have a permission assigned before implementation
- Every new UI feature must have a corresponding permission check on the backend
- Permissions must be documented alongside the feature spec

## Error Response

When a user lacks permission, use `errors.Forbidden()` via `libs/go-common/errors`:

```go
errors.Forbidden("You do not have permission to perform this action")
```

```json
{
  "error": "forbidden",
  "message": "You do not have permission to perform this action",
  "code": 403
}
```
