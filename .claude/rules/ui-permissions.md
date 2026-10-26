---
paths:
  - "apps/*/src/**"
  - "libs/ui-components/**"
  - "libs/api-client/**"
  - "libs/shared-types/**"
---

# UI Permission Gating Rule

All interactive UI elements (buttons, menu items, actions, links) must be conditionally rendered based on the user's roles and permissions. No permission-restricted element should be visible to unauthorized users.

## Principles

- Hidden by default — if a user lacks the required permission, the element is not rendered at all (not just disabled)
- Never rely on backend errors alone to hide UI — permission state must be evaluated client-side before render
- All permission checks must go through a single shared utility — no inline ad-hoc logic scattered across components

## Shared Hook / Utility

Use a single `usePermission(permission, scope?)` hook for all permission-based rendering:

```tsx
// Global permission
const canManageUsers = usePermission('users:write')

// Scoped permission
const canEditProject = usePermission('projects:write', { orgId: '123', projectId: '456' })

return canEditProject ? <EditButton /> : null
```

- `permission` — the `resource:action` string matching the RBAC naming convention
- `scope` — optional object providing resource context for scoped roles
- Returns a boolean — component decides what to render based on it

The hook is `usePermission` from `@depotex/platform-ui`. It reads `permissions` / `all_permissions` from `GET /api/auth/me`, is false while loading or signed out, and true outside an `AuthProvider` (unit tests only). For a resource-scoped permission pass the resource's `access` from the API as `scope` (`usePermission('spaces:settings:write', space.access)`).

## Global vs Scoped Roles

- Global permissions: pass no scope — evaluated against system-wide roles
- Scoped permissions: always pass the relevant resource context (org, project, team, etc.)
- A user may satisfy a permission via either a global or scoped role — the hook resolves both

## License Tier Gating in UI

- If a feature is restricted by license tier, use a `useLicense(minTier)` hook alongside `usePermission`
- License-gated elements show an upgrade prompt/tooltip instead of being silently hidden

```tsx
const hasLicense = useLicense('pro')
const canAccess = usePermission('analytics:read')

return hasLicense && canAccess ? <AnalyticsButton /> : <UpgradePrompt requiredTier="pro" />
```

## Rules

- Every new UI element tied to a permission must use `usePermission` — no exceptions
- Permission and license checks must be co-located with the component, not in parent layout logic
- Never use CSS (`display: none`, `visibility: hidden`) to hide permission-restricted elements — they must not be in the DOM
