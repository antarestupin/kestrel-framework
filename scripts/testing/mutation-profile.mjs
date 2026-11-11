import { readFileSync, statSync } from "node:fs";

const sourceRoot = new URL("../../src/packages/kestrel/src/", import.meta.url);

/** Keep profile selection separate from Stryker flags and reject accidental broad scopes. */
export function mutationArguments(args) {
  const remaining = [...args];
  let mode = "full";
  let component;
  if (remaining[0] === "--mode") {
    remaining.shift();
    mode = remaining.shift();
    if (!["fast", "component", "static-sample", "shutdown", "authentication-sessions", ...Object.keys(focusedProfiles)].includes(mode)) throw new Error("Unknown mutation mode.");
    if (mode === "component") {
      component = remaining.shift();
      if (!component || !/^[a-z][a-z0-9_]*$/u.test(component)
        || !statSync(new URL(`${component}/`, sourceRoot), { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error("Specify an existing framework component, for example: test:mutation:component -- di");
      }
    }
    if (remaining.some((arg) => !arg.startsWith("-") && /\.(?:mjs|cjs|js|json|ts)$/u.test(arg)
      || /^--(?:mutate|ignoreStatic|configFile)(?:=|$)/u.test(arg))) {
      throw new Error("Profile scope and static policy cannot be overridden; use test:mutation for custom runs.");
    }
  }
  // Every named assessment profile is bounded; the explicit full/custom command stays opt-in.
  return { mode, component, args: remaining, budgetMs: mode === "full" ? undefined : 600_000 };
}

/** Freeze the comparison scope to stop, disposal and shutdown error collection. */
export function shutdownPatterns() {
  const file = "app/app.ts";
  const lines = readFileSync(new URL(file, sourceRoot), "utf8").split("\n");
  const start = lines.findIndex((line) => line.includes("public stop(): Promise<void>"));
  const end = lines.findIndex((line) => line.includes("public runInObservationContext<"));
  if (start < 0 || end <= start) throw new Error("Application shutdown boundaries disappeared.");
  return [`src/packages/kestrel/src/${file}:${start + 1}-${end}`];
}

/** Select small import-time declarations across three different dependency graphs. */
export function staticSamplePatterns() {
  const selections = {
    "authentication/configuration.ts": ["const sameSiteSchema =", "name: z.string().min(1).default", "secure: z.boolean().default", "path: z.literal"],
    "throttling/configuration.ts": ['z.object({ strategy: z.literal("reject") })', 'strategy: z.literal("emergency-local")', "backendFailurePolicy: backendFailurePolicy.default"],
    "db/configuration.ts": ["options: z.string().default", "parameters: z.enum"],
  };
  return Object.entries(selections).flatMap(([file, anchors]) => {
    const lines = readFileSync(new URL(file, sourceRoot), "utf8").split("\n");
    return anchors.map((anchor) => {
      const line = lines.findIndex((value) => value.includes(anchor));
      if (line < 0) throw new Error(`Static sample declaration disappeared: ${file}: ${anchor}`);
      return `src/packages/kestrel/src/${file}:${line + 1}-${line + 1}`;
    });
  });
}

// Keep each behavioral lot independent so reports and ten-minute budgets stay comparable.
const focusedProfiles = {
  // Separate activation transactions from the rest of each workflow adapter.
  "workflow-activation-memory": [
    ["workflows/adapters/memory/adapter.ts", "public async commitActivation(", "public async completeActivities("],
    ["workflows/adapters/memory/adapter.ts", "private applyActivationOutcome(", "private enqueueWorkflowTask("],
  ],
  "workflow-activation-postgres": [
    ["workflows/adapters/postgres/adapter.ts", "public async commitActivation(", "public async completeActivities("],
  ],
  "workflow-memory-admission": [
    ["workflows/adapters/memory/adapter.ts", "", "public async commitActivation("],
  ],
  "workflow-memory-operations": [
    ["workflows/adapters/memory/adapter.ts", "public async completeActivities(", "public async requestCancellation("],
    ["workflows/adapters/memory/adapter.ts", "public async getHistory(", "private applyActivationOutcome("],
  ],
  "workflow-memory-internals": [
    ["workflows/adapters/memory/adapter.ts", "private enqueueWorkflowTask(", "private cancelOpenChildren("],
    ["workflows/adapters/memory/adapter.ts", "private deleteCommandTasks(", "private getOwnedTask("],
    ["workflows/adapters/memory/adapter.ts", "private getRequiredHistory("],
  ],
  "workflow-postgres-start": [
    ["workflows/adapters/postgres/adapter.ts", "", "public async get("],
  ],
  "workflow-postgres-reservation": [
    ["workflows/adapters/postgres/adapter.ts", "public async get(", "public async commitActivation("],
  ],
  "workflow-postgres-activities": [
    ["workflows/adapters/postgres/adapter.ts", "public async completeActivities(", "public async retryTask("],
    ["workflows/adapters/postgres/adapter.ts", "public async reserveActivityDispatches(", "public async requestCancellation("],
  ],
  "workflow-postgres-history": [
    ["workflows/adapters/postgres/adapter.ts", "public async getHistory(", "private async mutateReservations<"],
    ["workflows/adapters/postgres/adapter.ts", "private async admitPendingKeyedExecutions("],
  ],
  "workflow-runtime": [["workflows/runtime.ts"], ["workflows/provider.ts"], ["workflows/dependencies.ts"], ["workflows/completion_buffer.ts"]],
  "workflow-scheduler": [["workflows/scheduler.ts"]],
  "workflow-transports": [["workflows/activity_transport.ts"], ["workflows/worker_activity_transport.ts"]],
  "workflow-replay": [["workflows/replay/**/*.ts"], ["workflows/replayer.ts"], ["workflows/context.ts"]],
  "workflow-operations": [["workflows/client.ts"], ["workflows/operations.ts"], ["workflows/version_operations.ts"], ["workflows/execution_cursor.ts"]],
  "workflow-contracts": [["workflows/adapter.ts"], ["workflows/adapter_definition.ts"], ["workflows/errors.ts"], ["workflows/history.ts"], ["workflows/index.ts"], ["workflows/observations.ts"], ["workflows/concurrency.ts"], ["workflows/serialization.ts"], ["workflows/signal.ts"], ["workflows/testing.ts"], ["workflows/workflow.ts"]],
  "workflow-adapter-contracts": [["workflows/adapters/index.ts"], ["workflows/adapters/memory/definition.ts"], ["workflows/adapters/memory/index.ts"], ["workflows/adapters/postgres/configuration.ts"], ["workflows/adapters/postgres/definition.ts"], ["workflows/adapters/postgres/index.ts"], ["workflows/adapters/postgres/polling_error.ts"], ["workflows/adapters/postgres/schema.ts"]],
  "workers-contracts": [["workers/adapter_definition.ts"], ["workers/configuration.ts"], ["workers/dependencies.ts"], ["workers/errors.ts"], ["workers/index.ts"], ["workers/provider.ts"], ["workers/runtime.ts"], ["workers/types.ts"], ["workers/worker.ts"]],
  "workflow-terminal-control": [["workflows/adapters/memory/adapter.ts", "public async requestCancellation(", "public async retryExecution("], ["workflows/adapters/memory/adapter.ts", "private cancelOpenChildren(", "private deleteCommandTasks("], ["workflows/adapters/postgres/adapter.ts", "public async requestCancellation(", "public async retryExecution("], ["workflows/adapters/postgres/adapter.ts", "private async terminateExecutionTree(", "private async admitPendingKeyedExecutions("]],
  "workflow-task-ownership": [["workflows/adapters/memory/adapter.ts", "public async releaseTasks(", "public async getHistory("], ["workflows/adapters/memory/adapter.ts", "private getOwnedTask(", "private getRequiredHistory("], ["workflows/adapters/postgres/adapter.ts", "public async releaseTasks(", "public async getHistory("], ["workflows/adapters/postgres/adapter.ts", "private async mutateReservations<", "private async terminateExecutionTree("]],
  "workflow-execution-retry": [["workflows/adapters/memory/adapter.ts", "public async retryExecution(", "public async releaseTasks("], ["workflows/adapters/postgres/adapter.ts", "public async retryExecution(", "public async releaseTasks("]],
  "workers-delivery": [["workers/scheduler.ts", "public runOnce(", "private async canReserveUnderPressure("], ["workers/scheduler.ts", "private async runIndividual(", "private async runObservedInvocation("], ["workers/scheduler.ts", "private async flushOutcomes(", "function getReservationAllocation("], ["workers/scheduler.ts", "function getRetryDelay(", "function combineRequirements("]],
  // Assess the scheduler ranges left out of the delivery profile.
  "workers-scheduler": [
    ["workers/scheduler.ts", "", "public runOnce("],
    ["workers/scheduler.ts", "private async canReserveUnderPressure(", "private async runIndividual("],
    ["workers/scheduler.ts", "private async runObservedInvocation(", "private async flushOutcomes("],
    ["workers/scheduler.ts", "function getReservationAllocation(", "function getRetryDelay("],
    ["workers/scheduler.ts", "function combineRequirements("],
  ],

  "scheduled-runtime": [["scheduled_tasks/scheduler.ts"], ["scheduled_tasks/runtime.ts"]],
  "scheduled-adapters": [["scheduled_tasks/adapters/**/*.ts"]],
  "scheduled-contracts": [["scheduled_tasks/adapter_definition.ts"], ["scheduled_tasks/configuration.ts"], ["scheduled_tasks/dependencies.ts"], ["scheduled_tasks/index.ts"], ["scheduled_tasks/provider.ts"], ["scheduled_tasks/registry.ts"], ["scheduled_tasks/schedule.ts"], ["scheduled_tasks/task.ts"], ["scheduled_tasks/types.ts"]],
  "workers-publication": [["workers/client.ts"], ["workers/publication.ts"], ["workers/serialization.ts"], ["workers/acknowledgement_buffer.ts"], ["workers/deferral_buffer.ts"]],
  "workers-adapters": [["workers/adapters/**/*.ts"]],
  "outbound-resilience": [["outbound_http/deadline.ts"], ["outbound_http/body.ts"], ["outbound_http/middleware/retry/index.ts"]],

  "atlas-collection-query": [["atlas/client/src/collection.ts"]],
  "catalog-identities": [
    ["app/catalog.ts", "public readonly cliControllers =", "public readonly workers ="],
    ["app/catalog.ts", "public readonly workers =", "public readonly workflows ="],
  ],
  "execution-diagnostics": [
    ["app/execution_context.ts", "private replaceDiagnosticEntry(", "private assertWritable("],
    ["app/execution_context.ts", "function normalizeDestinations(", "function normalizeDiagnosticValue("],
    ["app/execution_context.ts", "function getDiagnosticSizeBytes(", "function assertPositiveInteger("],
  ],
  "cache-pruning": [
    ["cache/adapters/memory/adapter.ts", "public async prune(", "public async reset("],
    ["cache/adapters/memory/adapter.ts", "function validateLimit("],
    ["cache/adapters/postgres/adapter.ts", "public async prune(", "function validateAdapterOptions("],
    ["cache/adapters/postgres/adapter.ts", "function validatePruneLimit("],
  ],
  "actions-crud-pagination": [["actions/model_actions.ts"], ["actions/pagination.ts"], ["actions/cursor_pagination.ts"]],
  "authorization-decisions": [["authorization/manager.ts"]],
  "password-verification": [["authentication/mechanisms/password/hashers/argon2id/hasher.ts"]],
  "postgres-ownership": [
    ["workflows/adapters/postgres/adapter.ts", "public async retryTask(", "public async reserveActivityDispatches("],
    ["scheduled_tasks/adapters/postgres/adapter.ts", "public async extendLease(", "public async pruneExpiredRuns("],
  ],
  "throttling-inspection": [["throttling/adapters/leased/adapter.ts", "public reconcile(", "public allocateLeases("]],
  "lock-renewal": [
    ["lock/lock_manager.ts", "private async extendMany(", "private async tryAcquireMany("],
    ["lock/lock_manager.ts", "function validateExtensionBatch(", "/** Mutable internal implementation"],
  ],
};

/** Enumerate the named focused profiles for infrastructure validation. */
export function focusedProfileNames() {
  return Object.keys(focusedProfiles);
}

/** Resolve anchored ranges after source edits. An empty start anchor selects line one. */
export function focusedPatterns(mode) {
  return focusedProfiles[mode]?.map(([file, startAnchor, endAnchor]) => {
    const prefix = `src/packages/kestrel/src/${file}`;
    if (startAnchor === undefined) return prefix;
    const lines = readFileSync(new URL(file, sourceRoot), "utf8").split("\n");
    const start = lines.findIndex((line) => line.includes(startAnchor));
    const end = endAnchor === undefined ? lines.length
      : lines.findIndex((line, index) => index > start && line.includes(endAnchor));
    if (start < 0 || end <= start) throw new Error(`Mutation lot boundaries disappeared: ${mode}: ${file}`);
    return `${prefix}:${start + 1}-${end}`;
  });
}
