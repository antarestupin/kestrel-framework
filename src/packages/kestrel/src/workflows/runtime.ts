import { AsyncLocalStorage } from "node:async_hooks";

import type { Logger } from "pino";

import {
  executionCompletedObservation,
  executionStartedObservation,
  getExecutionObservationContext,
  getExecutionObservationError,
  setExecutionLogContext,
  type ActionExecution,
  type RuntimeApp,
} from "../app/index.js";
import { observerDependency, type Observer } from "../observability/index.js";
import { waitForShutdownSignal } from "../app/process.js";
import { abortableDelay } from "../scheduling/index.js";
import type { WorkflowAdapter } from "./adapter.js";
import type { AnyWorker, WorkerClient } from "../workers/index.js";
import { ActionWorkflowActivityTransport } from "./activity_transport.js";
import { setWorkflowActivityExecutionContext } from "./activity_transport.js";
import {
  WorkflowScheduler,
  type WorkflowSchedulerOptions,
} from "./scheduler.js";
import {
  WorkflowActivityOutboxDispatcher,
  type WorkflowActivityOutboxDispatcherOptions,
} from "./worker_activity_transport.js";
import { WorkflowVersionOperations } from "./version_operations.js";
import type { ReservedWorkflowTask } from "./adapter.js";

export interface WorkflowRuntimeOptions extends WorkflowSchedulerOptions {
  outbox?: WorkflowActivityOutboxDispatcherOptions;
}

/** Owns workflow polling and application execution scopes. */
export class WorkflowRuntime<Config> {
  public readonly scheduler: WorkflowScheduler;

  public readonly versions: WorkflowVersionOperations;

  private readonly executions = new AsyncLocalStorage<ActionExecution>();

  private readonly controller = new AbortController();

  private runPromise: Promise<void> | undefined;

  private startPromise: Promise<void> | undefined;

  private readonly dispatcher: WorkflowActivityOutboxDispatcher | undefined;

  public constructor(
    private readonly app: RuntimeApp<Config>,
    private readonly adapter: WorkflowAdapter,
    private readonly logger: Logger,
    options: WorkflowRuntimeOptions = {},
    activityWorker?: AnyWorker,
    workerClient?: WorkerClient,
  ) {
    const transport = new ActionWorkflowActivityTransport(
      app.catalog.actions.definitions,
      {
        execute: (action, input, activity) => {
          const execution = this.executions.getStore();

          if (execution === undefined) {
            throw new Error("Workflow Action executed outside its execution scope.");
          }

          setWorkflowActivityExecutionContext(execution.context, activity);
          return execution.get(action).run(input as never);
        },
      },
    );
    this.scheduler = new WorkflowScheduler(
      app.catalog.workflows.definitions,
      adapter,
      transport,
      {
        ...options,
        ...(adapter.activityDispatchMode === "outbox"
          ? { taskKinds: ["workflow", "timer"] as const }
          : {}),
        runInExecutionScope: (executionId, operation, run, task) =>
          this.runInExecutionScope(executionId, operation, run, task),
      },
    );
    this.versions = new WorkflowVersionOperations(
      app.catalog.workflows.definitions,
      adapter,
    );
    this.dispatcher = activityWorker === undefined || workerClient === undefined
      ? undefined
      : new WorkflowActivityOutboxDispatcher(
          adapter,
          workerClient,
          activityWorker,
          options.outbox,
        );

    if (adapter.activityDispatchMode === "outbox" && this.dispatcher === undefined) {
      throw new Error(
        "Outbox workflow activities require a Worker client and activity Worker.",
      );
    }
  }

  /** Starts polling without owning process-signal coordination. */
  public start(): Promise<void> {
    this.startPromise ??= this.startPolling();
    return this.startPromise;
  }

  public async run(): Promise<void> {
    try {
      await this.start();
      await waitForShutdownSignal();
    } finally {
      try {
        await this.stop();
      } finally {
        await this.app.stop();
      }
    }
  }

  public async stop(): Promise<void> {
    this.controller.abort();
    await this.runPromise;
  }

  private async startPolling(): Promise<void> {
    // Refuse the workflow workload before polling when deployed code cannot
    // replay every active pinned version. Other selected workloads are not
    // implicitly started or stopped by this runtime.
    await this.versions.assertCompatible();
    this.runPromise = Promise.all([
      this.scheduler.run(this.controller.signal),
      this.runDispatcher(this.controller.signal),
    ]).then(() => undefined);
    void this.runPromise.catch((error) => {
      this.logger.error(
        { err: error },
        "Workflow scheduler stopped unexpectedly",
      );
    });
  }

  private async runInExecutionScope<Result>(
    workflowExecutionId: string,
    operation: string,
    run: () => Promise<Result>,
    task: ReservedWorkflowTask,
  ): Promise<Result> {
    // One durable task can be reserved repeatedly. A distinct application
    // execution identity keeps attempts separate while workflow diagnostics
    // retain their stable orchestration correlation.
    const taskExecutionId = `${task.id}:${task.attempt}`;
    const execution = await this.app.createExecutionScope(taskExecutionId);
    setExecutionLogContext(execution.context, {
      operation,
      transport: "workflow",
      workload: "workflows",
    });
    // Reservation already joins the execution, so diagnostics add no round trip.
    execution.context.setDiagnostic("workflow.executionId", workflowExecutionId);
    execution.context.setDiagnostic("workflow.taskId", task.id);
    execution.context.setDiagnostic("workflow.name", task.workflowName);
    execution.context.setDiagnostic("workflow.version", task.workflowVersion);
    execution.context.setDiagnostic("workflow.generation", task.historyGeneration);
    execution.context.setDiagnostic("workflow.rootExecutionId", task.rootExecutionId);
    execution.context.setDiagnostic("workflow.replay", task.kind === "workflow");
    execution.context.setDiagnostic("workflow.taskKind", task.kind);
    execution.context.setDiagnostic("workflow.taskAttempt", task.attempt);
    if (task.commandSequence !== undefined) {
      execution.context.setDiagnostic("workflow.commandSequence", task.commandSequence);
    }
    if (task.parentExecutionId !== undefined) {
      execution.context.setDiagnostic(
        "workflow.parentExecutionId",
        task.parentExecutionId,
      );
    }
    const observer: Observer | undefined = execution.container.hasRegistration("observer")
      ? execution.container.resolve(observerDependency)
      : undefined;
    const startedAt = performance.now();
    let outcome: "failure" | "success" = "success";
    let executionError: unknown;

    return this.app.runInObservationContext(observer, async () => {
      observer?.record(
        executionStartedObservation,
        {
          operation,
          transport: "workflow",
          ...getExecutionObservationContext(execution.context),
        },
      );
      try {
        return await this.executions.run(execution, run);
      } catch (error) {
        executionError = error;
        outcome = "failure";
        throw error;
      } finally {
        observer?.record(
          executionCompletedObservation,
          {
            operation,
            transport: "workflow",
            ...getExecutionObservationContext(execution.context),
            ...(executionError === undefined
              ? {}
              : getExecutionObservationError(executionError)),
          },
          { outcome, durationMs: performance.now() - startedAt },
        );
        await execution.dispose(outcome);
      }
    });
  }

  private async runDispatcher(signal: AbortSignal): Promise<void> {
    if (this.dispatcher === undefined) return;

    while (!signal.aborted) {
      let published = 0;

      try {
        published = await this.dispatcher.runOnce();
      } catch (error) {
        this.logger.error(
          { err: error },
          "Workflow activity outbox publication failed",
        );
      }

      if (published === 0) await abortableDelay(100, signal);
    }
  }
}
