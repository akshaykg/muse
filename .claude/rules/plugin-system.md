---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
---

# Plugin System Rule

The application supports a plugin system for extending functionality. Plugins are sandboxed, signed, and interact with the core system only through defined APIs.

## Plugin Types

### Embedded Plugins
- Run inside the host process in a sandboxed environment
- Language-flexible via WASM runtime (any language that compiles to WASM)
- Strict resource limits enforced by the sandbox

### External Plugins (gRPC)
- Run as separate processes or containers — any language, any host
- Communicate with the core system via gRPC over a defined plugin protocol
- Can be hosted externally (third-party infrastructure)
- Must register with the core system and authenticate via plugin credentials

## Plugin Manifest

Every plugin must declare a manifest (`plugin.yaml`):

```yaml
name: my-plugin
version: 1.0.0
type: embedded | external
description: What this plugin does
author: Author Name
permissions:
  - storage:read
  - webhooks:send
  - users:read
hooks:
  - onUserCreated
  - onTicketUpdated
ui:
  - slot: dashboard-widget
    entry: ./ui/widget.js
  - slot: settings-panel
    entry: ./ui/settings.js
grpc:
  endpoint: plugin-host:50051  # external only
```

## Sandboxing & Isolation

- Embedded plugins run in a WASM sandbox — no direct access to host process, DB, filesystem, or network
- External plugins are process-isolated — communicate only via gRPC
- Resource limits (configurable per plugin via env vars):
  - `PLUGIN_MAX_MEMORY` — max memory per plugin (default: 64MB)
  - `PLUGIN_MAX_CPU_TIME` — max CPU time per execution (default: 5s)
  - `PLUGIN_EXEC_TIMEOUT` — max wall-clock time per execution (default: 30s)
- Network access: disabled by default for embedded plugins, opt-in with allowlisted domains
- A crashing plugin must never crash the host process — failures are caught and logged via `logger.FromContext(ctx).Error().Err(err)`

## Plugin API Surface

Plugins interact with the core system through:

### Hooks (Events)
- Plugins subscribe to events from the catalog (`libs/go-common/events`, `doc/internal-dev-doc/events/catalog.md`) in the before or after phase (e.g. `user.create` before, `ticket.update` after); delivery is the hook engine in `libs/go-common/hooks`
- Pre-hooks can inspect, mutate, or abort operations — see `event-hooks.md`
- Post-hooks receive a read-only snapshot and run in parallel
- Multiple plugins can subscribe to the same hook — pre-hooks run by priority, post-hooks run in parallel
- The hook engine handles timeouts, panic recovery, and mutation logging

### SDK Methods
- Limited set of actions exposed to plugins:
  - `sdk.storage.upload()`, `sdk.storage.download()`
  - `sdk.http.get()`, `sdk.http.post()` (allowlisted domains only for embedded)
  - `sdk.data.query()` — scoped, read-only data access via a query API (no raw SQL)
  - `sdk.ui.notify()`, `sdk.ui.showModal()`
- No raw DB access, no raw Redis access, no filesystem access — only through the SDK

### gRPC Protocol (External Plugins)
- Defined `.proto` files for the plugin protocol
- Core system calls plugin methods (e.g. `Execute`, `OnEvent`)
- Plugin calls core SDK methods via a reverse gRPC channel
- Authentication via plugin API key + mTLS

## UI Components

- Plugins can contribute UI components to predefined slots in the frontend
- Slots: `dashboard-widget`, `settings-panel`, `sidebar-item`, `detail-tab`, etc.
- Plugin UI is loaded in a sandboxed iframe — no direct DOM access to the host app
- Communication between plugin UI and host app via `postMessage` with a typed message protocol
- Plugin UI assets are served from the plugin package — not bundled with the main app
- Plugin UI must follow the theming rule — use CSS variables provided by the host

## Plugin Lifecycle

```
install → activate → running → deactivate → uninstall
```

- `install` — plugin package is uploaded/registered, manifest validated, signature verified
- `activate` — admin approves permissions, plugin starts receiving events
- `deactivate` — plugin stops receiving events, state preserved
- `uninstall` — plugin removed, all associated data cleaned up

## Permissions

- Plugins must declare all required permissions in the manifest upfront
- Admin must explicitly approve permissions on install — no silent escalation
- If a plugin update requests new permissions, re-approval is required
- Plugins can be enabled/disabled per tenant/org
- Permission violations are logged and the call is denied with a clear error

## Code Signing

### Certificate Trust Model
- A shared certificate library ships with the application containing default trusted signing certificates
- Users/admins can add their own trusted certificates to the library
- Plugin packages must be signed with a certificate from the trust store

### Signature Verification
- On install and on every load, the plugin signature is verified against the trust store
- **Signing enforcement ON** (default): unsigned or untrusted plugins are rejected — cannot be installed
- **Signing enforcement OFF** (master toggle `PLUGIN_SIGNING_REQUIRED=false`):
  - Signature is still checked on every load
  - Signed + trusted → normal operation
  - Unsigned or untrusted → plugin is marked as `untrusted` with a visible warning in the UI
  - Untrusted plugins still function but are flagged everywhere they appear
- The master toggle does NOT skip verification — it only changes the behavior from "reject" to "warn"

### Configuration
```
PLUGIN_SIGNING_REQUIRED=true          # true = reject untrusted, false = warn only
PLUGIN_TRUST_STORE_PATH=/etc/app/certs/plugins/
```

## Marketplace & Sources

- Plugins can come from:
  - **Official marketplace** — curated, signed with the default certificate
  - **Third-party** — signed with a user-added certificate
  - **Custom/internal** — developed by the tenant's own team
- Marketplace availability can be license-gated (e.g. custom plugins = Pro+, marketplace = Standard+)

## Audit & Observability

- All plugin lifecycle events are audit logged (install, activate, deactivate, permission changes, uninstall)
- Plugin execution is logged at `DEBUG` level via `logger.FromContext(ctx).Debug()` with: plugin name, hook/method, duration, outcome
- Plugin errors are logged at `ERROR` level via `logger.FromContext(ctx).Error().Err(err)` — never surfaced as raw errors to end users
- Plugin resource usage (memory, CPU) is tracked and available via admin API

## Rules

- No plugin may access the DB, Redis, filesystem, or network directly — only through the SDK
- No plugin may modify core system behavior — only extend via hooks and UI slots
- Every plugin must have a valid manifest — reject on install if missing or malformed
- Plugin UI runs in an iframe sandbox — no exceptions
- All plugin API calls are subject to RBAC — the plugin inherits the installing user's org context, not system-level access
- External plugins must authenticate via API key + mTLS — no unauthenticated gRPC connections
