---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
---

# Audit Logging Rule

All write operations on sensitive resources must be recorded in a central audit log. Audit logs are append-only and must never be modified or deleted.

## What to Log

Every audit entry must capture:

- `actor_id` — user ID who performed the action
- `actor_email` — email at time of action
- `ip_address` — request IP
- `user_agent` — request user agent
- `action` — `resource:action` format (e.g. `users:delete`, `billing:update`)
- `resource_type` — type of resource affected (e.g. `user`, `project`, `role`)
- `resource_id` — ID of the affected resource
- `org_id` — tenant/org context
- `outcome` — `success` or `failure`
- `timestamp` — UTC, always
- `before` — optional snapshot of resource state before change
- `after` — optional snapshot of resource state after change

## Storage

- Dedicated `audit_logs` table — never mixed with application data
- Append-only — no `UPDATE` or `DELETE` ever on this table, except the retention job deleting entries past the retention period, and one more exception: GDPR anonymization (`auth` module's `PersonalDataEraser`) blanks the erased person's `actor_email`, `ip_address` and `user_agent` and drops `before`/`after` snapshots of their user record. Entries themselves stay, attributed by ID
- Indexed on: `actor_id`, `resource_type`, `resource_id`, `org_id`, `timestamp`
- Enterprise tier: additionally stream to external sink (e.g. S3, Elasticsearch) for long-term retention

## Implementation

- A single `AuditLogger` service handles all audit writes — no inline audit logging in handlers
- Audit logging is async: `auth.PGAuditLogger` queues entries per node and writes them in batches, so it never blocks the request for long. It must not lose entries while the database is briefly unavailable: failed batches are retried, a full queue waits briefly before dropping, and every drop is counted (`Stats`) for the system check. The queue is flushed on shutdown
- For an action whose record must exist if and only if the change commits, use `PGAuditLogger.LogTx` inside the change's transaction
- If audit logging fails, the failure is logged via `logger.FromContext(ctx).Error().Err(err).Msg("audit log write failed")` but does NOT fail the request
- Audit logs always write regardless of the application `LOG_LEVEL` setting
- The `AuditLogger` must use `logger.Redact()` / `logger.Mask()` when logging `before`/`after` snapshots that may contain sensitive fields

## Access

- Audit log read API and export (`libs/platform/audit`, `/api/audit-logs`) are Pro tier and up, with the `audit_logs:read` permission: org admins see their own org's entries, super admins every org. Members don't have the permission (the trail holds other people's emails and addresses)
- Exports are themselves audited (`audit_logs:export`), and CSV exports neutralize spreadsheet formulas
- Streaming to an external sink is Enterprise
- Responses use standard cursor-based pagination
- Filterable by: `actor_id`, `action`, `resource_type`, `resource_id`, `org_id`, date range

## Retention

- Configurable via env var: `AUDIT_LOG_RETENTION_DAYS` (default: 90)
- Automatic cleanup of expired records via the `audit-log-retention` singleton job (retention editable in the scheduler UI)
- Enterprise tenants may configure longer retention periods

## Rules

- Never log secrets, tokens, or raw passwords in `before`/`after` snapshots — use `logger.Redact()` / `logger.Mask()` for sensitive fields
- Every new write endpoint must be assessed for audit logging requirement before implementation
- Audit log entries are immutable — no soft delete, no status updates
- Store action codes (`alerts:create`), resource ids and metadata values, never sentences. Anything stored is English or language-neutral; an audit viewer renders descriptions in the reader's language
