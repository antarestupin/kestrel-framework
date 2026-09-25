# Background runtime

[Usage index](./README.md) · [Implementation and shutdown ordering](../implementation/background.md)

Use `BackgroundProvider` to host workers, scheduled tasks and workflows together. Each workload retains its own definitions, storage and concurrency settings.

## Register the combined launcher

Choose the combined launcher when one process should host several kinds of background work. It reuses the workload providers already registered on the application.

```ts
import type { App } from "@kestrel/framework/app";
import { BackgroundProvider } from "@kestrel/framework/background";

function enableBackground<Config>(app: App<Config>) {
  // Register WorkerProvider, ScheduledTaskProvider and/or WorkflowProvider first.
  return app.register(new BackgroundProvider<Config>());
}
```

The combined provider discovers only the runtime registrations present during its composition. Register it after the selected workload providers and their infrastructure dependencies.

## Run all or selected workloads

Start every registered workload together for a simple deployment, or select only those assigned to this process. These commands use the [application CLI launcher](./cli.md#launch-the-application).

```sh
# Run every workload registered by the application.
./do run background
# Select only these two workloads for this process.
./do run background --workload workers --workload workflows
```

No selection means every registered background workload. Unknown or unavailable workloads fail before startup.

## Deploy workloads independently

Run workloads in separate processes when they need different capacity or deployment schedules. Each command selects one runtime from the same application composition.

```sh
# Each command below starts an independent process; choose the workload to deploy.
./do run workers
./do run scheduled-tasks --group maintenance
./do run workflows
```

Use the same application definition in each process with shared persistent adapters. The combined runtime coordinates startup and shutdown; it does not provide additional job durability. On partial startup failure it stops the workloads already started. During shutdown each scheduler drains or cancels according to its policy, and cleanup failures are reported after all cleanup attempts.

Continue with [workers](./workers.md), [scheduled tasks](./scheduled_tasks.md) or [workflows](./workflows.md) for workload-specific recipes.

## Use cases still to document

- Compose workers, scheduled tasks and workflows with their database, logger and lock prerequisites.
- Exercise combined startup failure and graceful shutdown with active workloads.
