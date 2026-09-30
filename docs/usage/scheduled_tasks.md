# Scheduled tasks

[Usage index](./README.md) · [Implementation and occurrence guarantees](../implementation/scheduled_tasks.md)

Use scheduled tasks for recurring maintenance and periodic work. Add definitions to a catalog's `scheduledTasks`, register `ScheduledTaskProvider` with resolved `scheduledTasksConfigBase`, and run the scheduled-task workload.

The default provider needs PostgreSQL, locks and an application logger. Register their providers first and install the scheduled-task tables. Use the memory adapter and scheduler directly for isolated tests.

## Install PostgreSQL storage

Add these objects to the application's global Drizzle schema and to the `schema` object passed to the [Kestrel migration generator](./database.md#install-library-schemas):

```ts
// Keep the library tables and namespace exported together.
export {
  scheduledTasksSchema,
  scheduledTaskStates,
  scheduledTaskRuns,
} from "@kestreljs/framework/scheduled_tasks";
```

Run `npm run db:generate`, review the generated SQL, then run `npm run db:migrate` before using PostgreSQL storage. The generator includes the library's database descriptions automatically; no separate custom SQL registration is required. Include the [lock schema](./lock.md#install-postgresql-storage) when using the default provider.

## Run maintenance after a delay

Use a loop schedule when maintenance should wait between completed runs. This cleanup task can postpone its next occurrence when there was nothing to remove.

```ts
import { defineCatalog } from "@kestreljs/framework/app";
import { dep } from "@kestreljs/framework/di";
import { defineScheduledTask, loop } from "@kestreljs/framework/scheduled_tasks";

type Pruner = { prune(): Promise<number> };
const cleanup = defineScheduledTask({
  id: "maintenance.cleanup",
  groups: ["maintenance"],
  schedule: loop({ delay: { minutes: 1 } }),
  // Skip another admission while this cleanup is already active.
  overlap: "skip",
  dependencies: { repository: dep<Pruner>("expiredRecordRepository") },
  handler: async ({ repository }, context) => {
    const removed = await repository.prune();
    // Idle maintenance can postpone its next regular occurrence.
    if (removed === 0) context.deferNextRun({ minutes: 5 });
  },
});
export const catalog = defineCatalog({ maintenance: { scheduledTasks: { cleanup } } });
```

Register the application-owned `expiredRecordRepository`. `loop` starts immediately by default and waits after completion; use `start: "after-delay"` when the first invocation should also wait.

## Choose a fixed cadence or calendar time

Choose a fixed cadence for periodic work or a cron expression for a wall-clock schedule. These examples cover a minute interval, an immediate first run and a weekday morning in a chosen time zone.

```ts
import { cron, every } from "@kestreljs/framework/scheduled_tasks";

const everyMinute = every({ minutes: 1 });
const immediatelyThenHourly = every({ hours: 1, start: "immediate" });
// Interpret 09:00 in this time zone, including daylight-saving changes.
const weekdayMorning = cron("0 9 * * 1-5", { timeZone: "Europe/Paris" });
```

Use one of these values as `schedule`. `every` keeps a cadence and coalesces missed occurrences. `cron` defaults to UTC. Manual runs do not shift regular cadence. The handler receives a cooperative abort signal, trigger and claimed occurrence time.

## Select tasks and control execution

Select tasks when a process should run only part of the registered schedule. Use manual controls for an immediate maintenance run or to pause regular admissions.

```sh
./do run scheduled-tasks
# Repeated group and task selections form a union.
./do run scheduled-tasks --group maintenance --task maintenance.cleanup
```

Repeated task/group filters form a union; unknown selections fail before polling. Studio exposes Run now, Pause and Resume. Pause prevents new regular admissions but does not abort an active handler, and explicit manual requests remain allowed.

Use `overlap: "skip"` to skip overlapping work, `"wait"` to coalesce until the active run completes, or `"parallel"` where concurrent runs are safe. Leases and occurrence records coordinate processes but do not make external effects exactly once; handlers should tolerate recovery after process loss. See [overlap and recovery](../implementation/scheduled_tasks.md#overlap-policy) for the detailed guarantees. `executionLog: false` and `observe: false` independently suppress automatic logs and observations for noisy maintenance.

## Use cases still to document

- Compose persistent scheduling with its database, lock and logger providers.
- Run an isolated scheduler with the memory adapter.
- Request a manual run and pause or resume a task programmatically.
- Handle overlap, cooperative cancellation and recovery after a lost lease.
