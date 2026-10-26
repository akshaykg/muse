---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
---

# Scheduler & Background Jobs Rule

All recurring and background jobs must go through the central scheduler at `libs/go-common/scheduler`. No ad-hoc goroutines, `time.Sleep` loops, or inline timers for scheduled work. This is a hard requirement — any new recurring task MUST be registered as a scheduler job.

## Library

- **Package**: `libs/go-common/scheduler` — the central scheduler framework
- **Underlying engine**: `gocron/v2` — managed internally by the scheduler package
- **Distributed locking**: leases in Postgres (`LeaseLockProvider` on `lock.Leases`) — singleton job coordination across cluster nodes, with or without Redis
- **Persistence**: PostgreSQL via the `Repository` interface — stores overrides, run history
- **Exception**: Node-local tasks (cache warming, local state refresh) use `JobTypeBroadcast` — they still go through the scheduler but run on every node

## Job Types

| Type | Constant | Behavior |
|------|----------|----------|
| Singleton Cron | `JobTypeSingletonCron` | Runs on exactly one node per cron tick. Uses a Postgres lease. |
| Singleton Interval | `JobTypeSingletonInterval` | Runs on exactly one node at a fixed interval from last completion. |
| Broadcast | `JobTypeBroadcast` | Runs on every node simultaneously. No lock needed. |

## Job Registration

Platform jobs are registered in `libs/platform/scheduler/jobs.go` via the `RegisterJobs` function. A product module registers its own jobs through the module contract's `JobProvider.RegisterJobs` — in one place per module, never scattered across packages.

```go
import schedulerlib "libs/go-common/scheduler"

func RegisterJobs(mgr *schedulerlib.Manager, deps JobDeps) error {
    // Built-in cleanup job (run history)
    if err := schedulerlib.RegisterCleanupJob(mgr); err != nil {
        return err
    }

    // App-specific jobs
    if err := mgr.Register(schedulerlib.JobDefinition{
        Name:        "my-new-job",
        Type:        schedulerlib.JobTypeSingletonCron,
        Schedule:    "0 * * * *",  // standard 5-field cron
        MaxDuration: 5 * time.Minute,
        Handler:     myHandler(deps),
        DefaultMetadata: map[string]any{
            "some_param": deps.SomeDefault,
        },
        Toggleable:       false,  // can users disable via UI?
        ScheduleEditable: true,   // can users change the cron expression?
        MetadataEditable: true,   // can users change metadata params?
        ManualRunnable:   true,   // can users trigger manually?
    }); err != nil {
        return err
    }

    return nil
}
```

### Handler Signature

All handlers must conform to:

```go
type HandlerFunc func(ctx context.Context, metadata map[string]any) error
```

- `ctx` carries the logger, cancellation, and timeout
- `metadata` contains runtime-configurable parameters (editable via UI if `MetadataEditable: true`)
- Return `nil` on success, non-nil error on failure

### Dependency Injection Pattern

Use a `JobDeps` struct to inject service functions into handlers without circular imports:

```go
type JobDeps struct {
    MyCleanup func(ctx context.Context, days int) error
    DefaultDays int
}
```

Wire it in `main.go` after services are initialized, then pass to `RegisterJobs`.

## Configurability Flags

| Flag | Effect |
|------|--------|
| `Toggleable` | If true, users can enable/disable the job via the scheduler UI |
| `ScheduleEditable` | If true, users can change the cron expression via UI |
| `MetadataEditable` | If true, users can change metadata parameters via UI |
| `ManualRunnable` | If true, users can trigger the job manually via UI |

For `Broadcast` jobs, all flags are forced to `false`.

## Run History for Frequent Jobs

Jobs that run every few seconds set `RecordRuns: schedulerlib.RecordFailures`: only failed and timed-out runs go to `scheduled_job_runs`; successful runs log at debug level, skip the last-run database write and raise no `scheduler.job.run` after-event. Failure alerting is unchanged. The event dispatcher (`event-dispatch`) is the example.

## Distributed Locking (Singleton Jobs)

- Lock key format: `scheduler:lock:{job_name}`
- Lock TTL: `2 × MaxDuration` (or global `SCHEDULER_LOCK_TTL` if MaxDuration is 0)
- If a node crashes mid-job, the lock auto-expires and another node picks it up on the next run
- On lock acquisition failure (another node is running it), the job is silently skipped — no error logged
- On job failure, the lock is released immediately
- Redis being unavailable doesn't affect singleton jobs; if Postgres is, the tick is skipped with a WARN log

## Retry Configuration

```go
schedulerlib.JobDefinition{
    MaxRetries:   3,
    RetryBackoff: schedulerlib.BackoffExponential, // none, fixed, exponential
}
```

- Each retry attempt is recorded as a separate run record
- Lock is held across all retry attempts
- Backoff delays: configurable via `SCHEDULER_RETRY_BASE_DELAY` and `SCHEDULER_RETRY_MAX_DELAY`

## Misfire Detection

On startup, the scheduler detects missed fire times for `SingletonCron` jobs:
- `MisfireSkip` (default): waits for next scheduled time
- `MisfireRunOnce`: triggers immediate execution of the missed job

## Alerting

- After `SCHEDULER_UNHEALTHY_THRESHOLD` (default: 3) consecutive failures, fires `scheduler.job.unhealthy` event
- On recovery after being unhealthy, fires `scheduler.job.recovered` event

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULER_LOCK_TTL` | `5m` | Global lock TTL (used when MaxDuration is 0) |
| `SCHEDULER_RUN_HISTORY_RETENTION_DAYS` | `30` | Days to keep run history |
| `SCHEDULER_RUN_HISTORY_MIN_RUNS_PER_JOB` | `50` | Minimum runs to keep per job regardless of age |
| `SCHEDULER_CHECK_TICKER_INTERVAL` | `10s` | Interval job check frequency |
| `SCHEDULER_RETRY_BASE_DELAY` | `30s` | Base delay for retry backoff |
| `SCHEDULER_RETRY_MAX_DELAY` | `5m` | Maximum retry delay |
| `SCHEDULER_UNHEALTHY_THRESHOLD` | `3` | Consecutive failures before alerting |
| `SCHEDULER_SHUTDOWN_GRACE_PERIOD` | `30s` | Time to wait for running jobs during shutdown |

## Observability

- Every job run is logged at `INFO` level via `logger.FromContext(ctx)` with: job name, type, node ID, start time, duration, outcome
- Failed jobs log at `ERROR` level with full error details
- Timeouts log at `WARN` level
- All runs are recorded in the `scheduled_job_runs` table with full metadata snapshots

## Rules

- **No ad-hoc goroutines or timers for recurring work** — use the scheduler. This is non-negotiable.
- Every new recurring task MUST be registered in `libs/platform/scheduler/jobs.go` (platform) or its module's `RegisterJobs` (product)
- Every singleton job automatically gets a distributed lock (a Postgres lease) — no manual lock code
- Editable job schedules must be validated (valid cron expression) before saving
- Jobs must be idempotent where possible — safe to run multiple times without side effects
- Job handlers must respect `context.Context` cancellation
- Scheduler startup/shutdown is graceful — waits for running jobs to complete before exit
- Use `logger.FromContext(ctx)` inside handlers — never the package-level logger
- Handler errors are propagated to the scheduler for run history recording — never swallow errors
