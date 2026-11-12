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
  // Keep large admission and storage implementations inside separate execution budgets.
  "throttling-admission": [
    ["throttling/manager.ts", "", "private enqueue("],
  ],
  "throttling-queues": [
    ["throttling/manager.ts", "private enqueue(", "private tryAcquireCircuits("],
  ],
  "throttling-circuits": [
    ["throttling/manager.ts", "private tryAcquireCircuits(", "private createPermit("],
  ],
  "throttling-completion": [
    ["throttling/manager.ts", "private createPermit("],
  ],
  "throttling-postgres-admission": [
    ["throttling/adapters/postgres/adapter.ts", "", "private async ensureLeaseBuckets("],
    ["throttling/adapters/postgres/adapter.ts", "private async executeReservations(", "function createLeaseDecision("],
  ],
  "throttling-postgres-leases": [
    ["throttling/adapters/postgres/adapter.ts", "private async ensureLeaseBuckets(", "private async executeReservations("],
    ["throttling/adapters/postgres/adapter.ts", "function createLeaseDecision("],
  ],
  "throttling-leased": [["throttling/adapters/leased/**/*.ts"]],
  "throttling-adapter-wrappers": [
    ["throttling/adapters/backend_failure/**/*.ts"],
    ["throttling/adapters/denial_caching/**/*.ts"],
  ],
  "throttling-storage": [
    ["throttling/adapters/index.ts"],
    ["throttling/adapters/memory/**/*.ts"],
    ["throttling/adapters/postgres/configuration.ts"],
    ["throttling/adapters/postgres/definition.ts"],
    ["throttling/adapters/postgres/index.ts"],
    ["throttling/adapters/redis/**/*.ts"],
  ],
  "throttling-contracts": [
    ["throttling/adapter_definition.ts"],
    ["throttling/configuration.ts"],
    ["throttling/definitions.ts"],
    ["throttling/dependencies.ts"],
    ["throttling/duration.ts"],
    ["throttling/errors.ts"],
    ["throttling/index.ts"],
    ["throttling/postgres_schema.ts"],
    ["throttling/types.ts"],
  ],
  // These disjoint profiles cover the contract files with a smaller static-mutant budget.
  "throttling-definitions-factories": [
    ["throttling/definitions.ts", "", "export function validateThrottlingDefinition("],
  ],
  "throttling-definitions-validation": [
    ["throttling/definitions.ts", "export function validateThrottlingDefinition("],
  ],
  "throttling-schema": [["throttling/postgres_schema.ts"]],
  "throttling-public-contracts": [
    ["throttling/adapter_definition.ts"],
    ["throttling/configuration.ts"],
    ["throttling/dependencies.ts"],
    ["throttling/duration.ts"],
    ["throttling/errors.ts"],
    ["throttling/index.ts"],
    ["throttling/types.ts"],
  ],
  "throttling-provider": [
    ["throttling/observations.ts"],
    ["throttling/provider.ts"],
    ["throttling/resource_pressure/**/*.ts"],
  ],
  // The existing session and Argon2id profiles supply the remaining authentication files.
  "authentication-adapters": [["authentication/adapters/**/*.ts"]],
  // The bundled PostgreSQL declarations contain only static mutants and dominate the adapter run.
  "authentication-adapters-postgres-schema": [["authentication/adapters/postgres/schema.ts"]],
  "authentication-adapters-runtime": [
    ["authentication/adapters/index.ts"],
    ["authentication/adapters/{composed,memory,redis}/**/*.ts"],
    ["authentication/adapters/postgres/{adapter,definition,index,tables}.ts"],
  ],
  "authentication-http": [
    ["authentication/attempt_guard.ts"],
    ["authentication/guards/**/*.ts"],
    ["authentication/http/**/*.ts"],
    ["authentication/middleware.ts"],
  ],
  "authentication-contracts": [
    ["authentication/actions.ts"],
    ["authentication/adapter_definition.ts"],
    ["authentication/configuration.ts"],
    ["authentication/context.ts"],
    ["authentication/definition.ts"],
    ["authentication/dependencies.ts"],
    ["authentication/errors.ts"],
    ["authentication/index.ts"],
    ["authentication/mechanisms/index.ts"],
    ["authentication/mechanisms/password/hashers/argon2id/index.ts"],
    ["authentication/mechanisms/password/index.ts"],
    ["authentication/mechanisms/password/mechanism.ts"],
    ["authentication/mechanisms/password/normalization.ts"],
    ["authentication/mechanisms/password/types.ts"],
    ["authentication/proof.ts"],
    ["authentication/provider.ts"],
    ["authentication/stores.ts"],
    ["authentication/types.ts"],
  ],
  // Separate adapter integration from token validation and cryptography.
  "tokens-adapters": [["tokens/adapters/**/*.ts"]],
  "tokens-strategies": [["tokens/strategies/**/*.ts"]],
  "tokens-contracts": [
    ["tokens/adapter_definition.ts"],
    ["tokens/configuration.ts"],
    ["tokens/definition.ts"],
    ["tokens/dependencies.ts"],
    ["tokens/index.ts"],
    ["tokens/lifetime.ts"],
    ["tokens/manager.ts"],
    ["tokens/provider.ts"],
    ["tokens/stored_strategy.ts"],
    ["tokens/types.ts"],
  ],
  // Separate database contracts so integration-heavy paths stay inside the same run budget.
  "db-provider": [
    ["db/configuration.ts"],
    ["db/database_manager.ts"],
    ["db/index.ts"],
    ["db/pool_runtime.ts"],
    ["db/provider.ts"],
  ],
  "db-instrumentation": [
    ["db/middleware.ts"],
    ["db/observations.ts"],
    ["db/query_instrumentation.ts"],
  ],
  "db-repository": [
    ["db/collection.ts"],
    ["db/pagination.ts"],
    ["db/repository.ts"],
  ],
  "db-history-declarations": [["db/history/definition.ts", "", "function selectHistoryColumns<"]],
  "db-history-column-types": [["db/history/definition.ts", "function selectHistoryColumns<", "function resolveIdentityKeys<"]],
  "db-history-identities": [["db/history/definition.ts", "function resolveIdentityKeys<"]],
  "db-history-events": [
    ["db/history/context.ts"],
    ["db/history/index.ts"],
    ["db/history/reader.ts"],
    ["db/history/trigger_sql.ts"],
  ],
  "db-reference-counter-declarations": [["db/reference_counter/definition.ts", "", "export function getReferenceCounterDefinitions("]],
  "db-reference-counter-discovery": [["db/reference_counter/definition.ts", "export function getReferenceCounterDefinitions("]],
  "db-reference-counter-runtime": [
    ["db/reference_counter/cli.ts"],
    ["db/reference_counter/index.ts"],
    ["db/reference_counter/maintenance.ts"],
    ["db/reference_counter/sql.ts"],
    ["db/reference_counter/trigger_sql.ts"],
    ["db/reference_counter/types.ts"],
  ],
  "db-schema-table-metadata": [
    ["db/dev_schema.ts"],
    ["db/framework_table.ts"],
    ["db/schema_contributions/apply.ts"],
    ["db/schema_contributions/definition.ts"],
    ["db/schema_contributions/index.ts"],
    ["db/utils_schema.ts"],
  ],
  "db-schema-migrations": [
    ["db/schema_contributions/description_diff.ts"],
    ["db/schema_contributions/migration_generator.ts"],
  ],
  "db-schema-descriptions": [
    ["db/schema_contributions/descriptions.ts"],
    ["db/schema_contributions/unlogged_table.ts"],
    ["db/sql_dollar_quote.ts"],
  ],
  // Assess HTTP route contracts, access checks, runtime policies and client tooling independently.
  "http-routing": [
    ["http/bindings.ts"],
    ["http/controller.ts"],
    ["http/model_list_controller.ts"],
    ["http/route.ts"],
  ],
  "http-access": [
    ["http/access.ts"],
    ["http/audiences/**/*.ts"],
    ["http/controller_executor.ts"],
    ["http/controller_manager.ts"],
    ["http/middleware.ts"],
  ],
  "http-runtime": [
    ["http/configuration.ts"],
    ["http/dependencies.ts"],
    ["http/extension.ts"],
    ["http/hardening/**/*.ts"],
    ["http/index.ts"],
    ["http/maintenance/**/*.ts"],
    ["http/provider.ts"],
    ["http/runtime.ts"],
  ],
  "http-clients": [
    ["http/client.ts"],
    ["http/client_generation/**/*.ts"],
  ],
  "outbound-resilience": [["outbound_http/deadline.ts"], ["outbound_http/body.ts"], ["outbound_http/middleware/retry/index.ts"]],
  "outbound-client": [["outbound_http/client.ts"], ["outbound_http/response.ts"]],
  "outbound-contracts": [
    ["outbound_http/configuration.ts"],
    ["outbound_http/defaults.ts"],
    ["outbound_http/dependencies.ts"],
    ["outbound_http/errors.ts"],
    ["outbound_http/index.ts"],
    ["outbound_http/middleware.ts"],
    ["outbound_http/middleware/cache/**/*.ts"],
    ["outbound_http/middleware/index.ts"],
    ["outbound_http/middleware/throttling/**/*.ts"],
    ["outbound_http/observations.ts"],
    ["outbound_http/provider.ts"],
    ["outbound_http/types.ts"],
  ],

  // Partition App lifecycle, execution and catalog independently of their shared import graph.
  "app-composition": [["app/app.ts", "", "public async createExecutionScope("]],
  "app-execution": [
    ["app/app.ts", "public async createExecutionScope(", "public start("],
    ["app/app.ts", "public runInObservationContext<"],
    ["app/execution_scope.ts"],
  ],
  "app-startup": [["app/app.ts", "public start(", "public stop("]],
  "app-shutdown": [["app/app.ts", "public stop(", "public runInObservationContext<"]],
  "app-shutdown-coordination": [["app/shutdown.ts"], ["app/process.ts"]],
  "app-execution-context": [["app/execution_context.ts"]],
  "app-catalog": [["app/catalog.ts"]],
  "app-contracts": [
    ["app/adapter.ts"], ["app/events.ts"], ["app/index.ts"],
    ["app/observations.ts"], ["app/workloads.ts"],
  ],
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
  // Separate admission, lease ownership and backend behavior while covering every lock source.
  "lock-acquisition": [
    ["lock/lock_manager.ts", "", "public async runExclusive<Value>("],
  ],
  "lock-ownership": [
    ["lock/lock_manager.ts", "public async runExclusive<Value>("],
  ],
  "lock-adapters": [["lock/adapters/**/*.ts"]],
  "lock-contracts": [
    ["lock/adapter_definition.ts"],
    ["lock/configuration.ts"],
    ["lock/dependencies.ts"],
    ["lock/errors.ts"],
    ["lock/index.ts"],
    ["lock/observations.ts"],
    ["lock/postgres_schema.ts"],
    ["lock/provider.ts"],
    ["lock/types.ts"],
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
