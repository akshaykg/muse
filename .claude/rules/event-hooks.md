---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
---

# Event Hooks Rule

Every major operation is an **event** in the catalog (`libs/go-common/events`), raised in the service layer so policies, automation and plugins can subscribe to it. How-to: `doc/internal-dev-doc/events/README.md`. Generated catalog: `doc/internal-dev-doc/events/catalog.md`.

## Does this feature need events? (check for every new feature)

Answer before implementing, and note the answer in the feature's developer doc:

| The feature… | Events |
|---|---|
| Creates, updates or deletes something users or admins care about | Yes: `resource.create/update/delete`, before (blocking) and after |
| Is security-relevant (sign-in, roles, tokens, keys, settings, licenses) | Yes, before and after; `FailMode: events.FailClosed` |
| Changes state an admin may want to control, restrict or automate (job runs, uploads, node joins) | Yes |
| Reports something that happened with no user action (job unhealthy, node lost) | Yes, after only |
| Is a read, a list, or a purely internal/technical step | No; say so in the dev doc |

If yes, the feature isn't done until **all** of these are true:

- [ ] Defined with `events.Define` in the feature package's `events.go` (description, category, phases, levels, mutable and sensitive fields)
- [ ] Raised with `events.Before` / `events.After` in the service layer
- [ ] Catalog page regenerated (`UPDATE_EVENT_CATALOG=1 go test ./kernel/ -run EventCatalog` for platform events; the product's own catalog test for product events). The test fails until you do
- [ ] **Developer docs:** the feature's guide lists its events; `doc/internal-dev-doc/events/README.md` updated if the events API or conventions changed
- [ ] If the event creates something that lasts (a token, a repository, a user), the module implements `module.StateProvider` for it, so policy compliance scans can check items that existed before a policy did
- [ ] **Product docs:** the docs-site events reference lists the event with what admins can do with it (policies, automation, plugins), and the feature's own page mentions it; changelog line when admins can use it

Changing an existing event (payload fields, mutable/sensitive lists, levels, blocking) follows the same checklist. Removing or renaming a payload field needs a new `Version`.

## Defining and raising events

```go
var UserCreate = events.Define[UserCreateInput, User]("user.create", events.Options{
    Description: "A user account is created.",
    Category:    "users",
    Phases:      events.PhaseBefore | events.PhaseAfter,
    Blocking:    true,
    Levels:      []events.Level{events.Platform, events.Org},
    Mutable:     []string{"role"},     // fields a blocking subscriber may change
    Sensitive:   []string{"password"}, // never sent to subscribers
    FailMode:    events.FailClosed,    // security event
})

in, err := events.Before(ctx, s.bus, UserCreate, in) // may deny or change Mutable fields
err = db.RunInTx(ctx, s.pool, nil, func(tx pgx.Tx) error {
    user, err := s.repo.Create(ctx, tx, in)
    if err != nil {
        return err
    }
    return events.AfterTx(ctx, s.bus, tx, UserCreate, *user) // stored with the change
})
```

- Services raise events on `deps.Bus()` (the durable bus in a server).

- Names are `resource.action` in lower case. Never pass `before:`/`after:`; the phase is part of the call.
- Never call `RunPre`/`RunPost` outside `libs/go-common/hooks` and `events` (a test enforces it).
- Raise events in the service layer only, never in handlers or repositories.
- `Define` validates at startup: unknown `Mutable`/`Sensitive` fields, a missing description or category, or a duplicate name panic.

## Blocking subscribers (before)

- Run sequentially in priority order (lower first), each receiving the previous one's output.
- Can **abort** (`hooks.Abort(msg, "user"|"internal")`); the service maps it to an `AppError` with a reason.
- Can return an `AppError` directly (the policy engine returns 403 `policy_denied` / `policy_error`): services **must pass an `AppError` from `events.Before` through unchanged**, never wrap it in a 500.
- Policies (`libs/platform/policy`) are the first blocking subscriber on every event that is `Blocking` with `events.Org` in `Levels`. Adding `Org` to an event lets org admins restrict it; list in `Mutable` only fields that are safe for a policy to set.
- Can change only the event's `Mutable` fields; other changes are reverted and logged. Changes are logged at INFO with before/after values; sensitive fields are never in the payload.
- Time-boxed: the handler's `Timeout`, else `PLUGIN_PREHOOK_TIMEOUT` (5s). On expiry the handler's ctx is cancelled and the operation aborted, or the handler skipped with `OnTimeout: "skip"`.

## Non-blocking subscribers (after)

- After-events go through the durable outbox: `events.AfterTx` inside the write's transaction (preferred: the event exists if and only if the change commits), or `events.After` when there is no transaction. They survive crashes and are delivered once per cluster by the `event-dispatch` job.
- Subscribers register with `events.Subscribe(deps.Events, ev, name, opts, fn)` at startup, on every node. Delivery is **at least once**: handlers must be idempotent (use `DeliveryID`). A returned error is retried with backoff, then the delivery is marked dead.
- They receive the result with sensitive fields removed, never affect the operation or the response, and are time-boxed (`EVENT_SUBSCRIBER_TIMEOUT`).
- Engine post-hooks (`engine.OnAfter`) still work (delivered once per cluster via the outbox, no retries); new subscribers use `events.Subscribe`.

## Handlers

```go
engine.OnBefore("user.create", hooks.PreHookHandler{
    Name: "plugin:domain-check", Priority: 10,
    Fn: func(ctx context.Context, hc hooks.HookContext, p map[string]any) (map[string]any, error) {
        return p, nil
    },
})
```

Handlers must honour `ctx` (cancellation and timeouts).

## Rules

- Every new feature is checked against the table above; every event follows the checklist, including both developer and product docs
- Every new write operation on user-visible or security-relevant data raises before and after events
- Blocking subscribers run sequentially; non-blocking ones never block the response
- All subscriber executions are subject to the subscriber's declared permissions (plugins, policies)
- Payload changes are versioned; the catalog page is always current
