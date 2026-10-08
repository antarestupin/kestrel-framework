# Durable workflows

[Usage index](./README.md) · [Implementation, replay and operations](../implementation/workflows.md)

Provider composition and backend settings follow the [shared adapter configuration contract](./configuration.md#configure-providers-and-their-backends).

Use workflows for orchestration that must survive waits and process restarts. Put effects in actions; keep workflow handlers deterministic and express waits through the durable context.

## Install PostgreSQL storage

Add these objects to the application's global Drizzle schema and to the `schema` object passed to the [Kestrel migration generator](./database.md#install-library-schemas):

```ts
// Keep the library tables and namespace exported together.
export {
  workflowsSchema,
  workflowExecutions,
  workflowHistoryArchives,
  workflowHistoryEvents,
  workflowTasks,
  workflowSignals,
  workflowDispatchOutbox,
} from "@kestreljs/framework/workflows";
```

Run `npm run db:generate`, review the generated SQL, then run `npm run db:migrate` before using PostgreSQL storage. The generator includes the library's database descriptions automatically; no separate custom SQL registration is required. Add the [worker schema](./workers.md#install-postgresql-storage) when using worker-backed activities.

## Orchestrate an action, signal and timer

Use a workflow when a process must wait for an external decision and resume durably. This report flow prepares a result, waits for approval and delays publication.

```ts
import { z } from "zod";
import { defineAction } from "@kestreljs/framework/actions";
import { defineCatalog } from "@kestreljs/framework/app";
import { defineWorkflow, defineWorkflowSignal } from "@kestreljs/framework/workflows";

const prepare = defineAction({
  name: "report.prepare", input: z.object({ reportId: z.string() }),
  output: z.string(), handler: ({ reportId }) => `Prepared ${reportId}`,
});
const approved = defineWorkflowSignal({ name: "report.approved", payload: z.object({ approved: z.boolean() }) });
const publishReport = defineWorkflow({
  name: "report.publish", version: { current: 1, supportedFrom: 1 },
  input: z.object({ reportId: z.string() }), output: z.string(),
  signals: [approved],
  handler: async (input, workflow) => {
    // Run effects through a durable activity so replay can reuse its recorded outcome.
    const result = await workflow.run(prepare, input);
    // Persist the wait so approval can arrive after a process restart.
    const decision = await workflow.waitForSignal(approved, { timeout: { days: 1 } });
    if (!decision.approved) throw new Error("Report rejected.");
    await workflow.sleep({ minutes: 5 });
    return result;
  },
});
export const catalog = defineCatalog({
  reports: { actions: { prepare }, workflows: { publishReport } },
});
```

Register `WorkflowProvider(postgresWorkflows(database))` after the PostgreSQL and logger providers, install its schema, and run `./do run workflows` or the [background runtime](./background.md). Embedded action execution is the default. `activityTransport: "worker"` requires `activityDispatchMode: "outbox"` in the adapter definition, a worker provider and a running workers workload as well.

## Start, signal and read the result

Use the workflow client when application code must start an execution, deliver an external decision and await completion. Stable identifiers make repeated starts and signal submissions safe to deduplicate.

```ts
import type { WorkflowClient } from "@kestreljs/framework/workflows";

async function startReport(client: WorkflowClient) {
  const handle = await client.start(publishReport, { reportId: "report-42" }, {
    // Reuse this stable ID when retrying a compatible start request.
    executionId: "report-publication-42",
  });
  // Deduplicate repeated delivery of this external approval.
  await handle.signal(approved, { approved: true }, { idempotencyKey: "approval-42" });
  // A scheduler must be running for this wait to reach completion.
  return handle.result();
}
```

Inject `workflowClientDependency` in application services. Repeated compatible execution IDs are idempotent; signals may arrive before the workflow waits for them. Authorize signal publication at the application boundary. `startMany` atomically starts a bounded batch and retains input order.

## Add retries and parallel work

Run independent activities in parallel when neither needs the other's result. Configure retries and timeouts for infrastructure failures while leaving business failures to workflow code.

```ts
const prepareTwo = defineWorkflow({
  name: "report.prepare-two", version: { current: 1, supportedFrom: 1 },
  input: z.object({ first: z.string(), second: z.string() }),
  output: z.tuple([z.string(), z.string()]),
  handler: async (input, workflow) => {
    const options = {
      retry: { maxAttempts: 3, initialDelay: { seconds: 1 }, backoffCoefficient: 2 },
      startToCloseTimeout: { minutes: 1 },
    };
    // Both branches use durable activities that can be replayed independently.
    return Promise.all([
      workflow.run(prepare, { reportId: input.first }, options),
      workflow.run(prepare, { reportId: input.second }, options),
    ]);
  },
});
```

Only classified activity infrastructure failures/timeouts follow this retry policy; ordinary action failures return to workflow code. Use `try`/`catch` and compensating actions where appropriate. Parallel/race promises must come from durable operations. An already running race loser can still produce effects.

## Keep execution replayable

Apply these rules when a workflow uses generated values, grows a long history or changes across deployments. Persisted executions must replay the same durable decisions after resuming.

Use `workflow.now()`, `workflow.uuid()` or `workflow.sideEffect()` for captured nondeterminism; do not call external services or native timers directly inside the handler. Use `runChild` for another workflow and `continueAsNew` to rotate long histories. Durable values must round-trip through the configured payload codec, JSON by default.

Effects are at least once. Actions can read `getWorkflowActivityExecutionContext` from their execution context to obtain a stable activity idempotency key. Use it when the external destination supports deduplication.

When changing command order, preserve branches for pinned `workflow.version` values and validate replay fixtures before deployment. `concurrency.keyed` can serialize executions by business key with enqueue/reject/return-existing policies. The [version and replay guide](../implementation/workflows.md#version-operations-and-replay-fixtures) covers compatibility checks.

Operational endpoints use `workflowOperationsDependency` behind application authorization. Pause stops new reservations; cancel requests cooperative compensation; terminate stops orchestration without compensation. Studio exposes these controls and execution history. See the [operations reference](../implementation/workflows.md#operational-api) before choosing a destructive control.

## Use cases still to document

- Compose PostgreSQL persistence and worker-backed activities with stable effect idempotency keys.
- Run child workflows and implement cooperative cancellation with compensation.
- Capture nondeterministic values and rotate histories with continueAsNew.
- Evolve workflow versions and validate replay fixtures.
- Start batches and serialize executions by business key.
- Expose authorized pause, resume, retry, recovery and termination controls.
