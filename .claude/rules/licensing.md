---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
  - "localtools/licensing/**"
  - "apps/*/src/app/settings/application/licensing/**"
---

# Licensing Rule

All features must be gated by license tier where applicable. License checks are enforced on the backend via `libs/go-common/license`.

## License Tiers

Three tiers in ascending order of capability:

- **Standard** — base tier, core features only
- **Pro** — standard + advanced features
- **Enterprise** — pro + enterprise-grade features (e.g. SSO, audit logs, advanced RBAC, cluster features)

## License States

The license library defines five states that control app behavior:

| Status | Meaning | App behavior |
|--------|---------|-------------|
| `StatusNone` | No license file — fresh install | Only setup paths accessible |
| `StatusValid` | Active license | Full access based on tier |
| `StatusGrace` | Expired but within grace period | Full access + warning header |
| `StatusExpired` | Expired past grace | Only whitelisted paths accessible |
| `StatusInvalid` | Bad signature or wrong machine | Same as expired |

## Backend Enforcement

License verification is done once at startup via `license.Load()` and cached in memory:

```go
info := license.Load(license.Options{
    LicensePath: "/etc/app/license.json",
    PublicKeys:  []ed25519.PublicKey{currentKey, previousKey},
    MachineID:   clusterID,
})
```

Global middleware enforces license state on every request:

```go
router.Use(license.NewMiddleware(info, license.MiddlewareOptions{
    SetupPaths:   []string{"/setup", "/api/setup"},
    ExpiredPaths: []string{"/api/health", "/api/auth/login", "/api/admin/license"},
}))
```

Per-route tier gating:

```go
proRoutes.Use(license.RequireTier(info, "pro"))
enterpriseRoutes.Use(license.RequireTier(info, "enterprise"))
```

User and node limit checks in services:

```go
if info.UserLimitReached(currentUserCount) {
    return errors.Forbidden("User limit reached for your license")
}
if info.NodeLimitReached(currentNodeCount) {
    return errors.Forbidden("Node limit reached for your license")
}
```

## Check Order

When both RBAC and license checks apply, enforce in this order:
1. Authentication (is the user logged in?)
2. License check (`license.NewMiddleware` + `license.RequireTier`)
3. RBAC check (does this user have the required permission?)

This ensures license violations surface before permission errors.

## Feature Gating

- Every new feature must declare its minimum license tier before implementation
- Features available on all tiers must still be explicitly marked as `Standard+`
- Tier requirements must be documented alongside the feature spec

## Error Response

When a feature is not available on the tenant's current tier, use `errors.LicenseRequired()`:

```go
errors.LicenseRequired("pro", "standard")
```

This produces:

```json
{
  "error": "license_required",
  "message": "This feature requires a pro license or higher",
  "code": 402,
  "details": {
    "requiredTier": "pro",
    "currentTier": "standard"
  }
}
```

## Upgrade Prompt

- HTTP 402 is used for license tier violations (distinct from 403 for permission violations)
- The frontend must handle 402 responses by showing an upgrade prompt to the user

## License Token Format

Licenses are JSON files signed with Ed25519. The token structure:

```json
{
  "license_id": "8a1304aa-fa42-43c5-a124-f7d6dd7f33f1",
  "licensee_name": "Acme Corp",
  "machine_id": "8e46259114fa37450eee7b39cfd07ca8",
  "issued_at": "2026-04-28T10:51:06.610621Z",
  "expires_at": "2027-12-31T00:00:00Z",
  "entitlements": ["pro-features", "team-collaboration"],
  "grace_period_days": 14,
  "max_users": 50,
  "max_nodes": 5,
  "signature": "/2A9I6cEhyMFKuzAZlYntuWbvAgVLg0PBSy9pDpTb5YNQBGml6ykizRM6r8pw2ljnhBEbrokBxMuK/U5GEQ6DA=="
}
```

| Field | Type | Description |
|-------|------|-------------|
| `license_id` | string | UUID v4, unique per license |
| `licensee_name` | string | Name of the licensee |
| `machine_id` | string | 32-char hex, first 128 bits of SHA-256 of hardware attributes |
| `issued_at` | string | UTC timestamp (RFC3339) when the license was generated |
| `expires_at` | string | UTC timestamp (RFC3339) when the license expires |
| `entitlements` | string[] | List of features granted (maps to license tiers) |
| `grace_period_days` | int | Optional, 1–30 days of continued access after expiry |
| `max_users` | int | Optional, maximum users allowed (0 or absent = unlimited) |
| `max_nodes` | int | Optional, maximum cluster nodes allowed (0 or absent = unlimited) |
| `signature` | string | Base64-encoded 64-byte Ed25519 signature |

## Machine ID Format

- **Single-node deployments**: 32 hex characters derived from hardware (MAC, CPU, disk, OS machine ID → SHA-256 → first 16 bytes)
- **Cluster deployments**: UUID stored in the `cluster_info` database table, shared by all nodes
- Both dashed (`8E46-2591-14FA-3745-0EEE-7B39-CFD0-7CA8`) and raw formats accepted everywhere
- The app provides the machine ID to `license.Load()` — the library doesn't decide the source

## Decoding / Verification Process

All verification is handled by `libs/go-common/license`. The process:

1. `license.Load()` reads the license file at startup
2. `license.Verify()` re-serializes fields (minus signature) into canonical JSON
3. Verifies Ed25519 signature against each public key in order (supports key rotation)
4. Compares `machine_id` in token against the provided machine/cluster ID
5. Checks `expires_at` + `grace_period_days` against current time
6. Resolves entitlements → tier (enterprise > pro > standard)
7. Returns immutable `*LicenseInfo` cached for the process lifetime

## Key Rotation

`license.Load()` accepts multiple public keys via `PublicKeys []ed25519.PublicKey`. Keys are tried in order — first valid signature wins. This enables zero-downtime key rotation:

1. Generate new key pair
2. Deploy app with `PublicKeys: [newKey, oldKey]`
3. Issue new licenses with new key
4. After all old licenses expire, remove `oldKey`

## License Permissions (RBAC)

| Permission | Scope | Description |
|------------|-------|-------------|
| `licenses:request` | User | Submit machine ID to get a license via activation page |
| `licenses:admin` | Admin | Generate licenses, view history via admin dashboard |
| `licenses:keys:manage` | Admin | View/manage signing key metadata |

## License Generation Tool

The CLI tool at `localtools/licensing/` generates and verifies licenses. See `doc/internal-dev-doc/licensing tool/README.md` for full usage documentation.
