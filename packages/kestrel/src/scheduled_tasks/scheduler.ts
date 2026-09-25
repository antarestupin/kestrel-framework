import {
  type RuntimeApp,
  executionCompletedObservation,
  executionStartedObservation,
  getExecutionObservationError,
  getExecutionObservationContext,
  setExecutionLogContext,
  type ExecutionScope,
} from "../app/index.js";
import { abortableDelay } from "../scheduling/index.js";
import type { LockHandle, Locks } from "../lock/index.js";
import {
  type Observer,
  observerDependency,
} from "../observability/index.js";
import { setExecutionLogEnabledDependency } from "../log/index.js";
import { MemoryScheduledTaskAdapter } from "./adapters/memory/index.js";
import {
  createNextRunDeferral,
  type AnyScheduledTask,
  type ScheduledTaskCoordination,
  type ScheduledTaskStateKind,
} from "./task.js";
import {
  serializeScheduledTaskError,
  type ReserveScheduledTaskRequest,
  type ScheduledTaskAdapter,
  type ScheduledTaskReservation,
  type ScheduledTaskState,
} from "./types.js";

export interface ScheduledTaskRuntimeDefaults {
  state: ScheduledTaskStateKind;
  coordination: ScheduledTaskCoordination;
}

export interface ScheduledTaskSchedulerAdapters {
  memory?: ScheduledTaskAdapter;
  persistent?: ScheduledTaskAdapter;
}

export interface ScheduledTaskSchedulerOptions {
  slots: number;
  leaseMs: number;
  pollIntervalMs?: number;
  defaultRuntime?: ScheduledTaskRuntimeDefaults;
  allowTaskRuntimeOverrides?: boolean;
  now?: () => Date;
  reportError?: (error: unknown) => void;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

interface ResolvedTask {
  task: AnyScheduledTask;
  adapter: ScheduledTaskAdapter;
  state: ScheduledTaskStateKind;
  coordination: ScheduledTaskCoordination;
}

/** Coordinates recurring task admission and application-scoped executions. */
export class ScheduledTaskScheduler<Config> {
  private readonly now: () => Date;

  private readonly reportError: (error: unknown) => void;

  private readonly sleep: (
    delayMs: number,
    signal: AbortSignal,
  ) => Promise<void>;

  private readonly pollIntervalMs: number;

  private readonly resolvedTasks: readonly ResolvedTask[];

  private readonly activeInvocations = new Set<Promise<void>>();

  private readonly activeTaskCounts = new Map<string, number>();

  private loopAbortController: AbortController | undefined;

  private handlerAbortController = new AbortController();

  private loopPromise: Promise<void> | undefined;

  private initializePromise: Promise<void> | undefined;

  private admissionCycle: Promise<readonly Promise<void>[]> | undefined;

  public constructor(
    private readonly app: RuntimeApp<Config>,
    adapters: ScheduledTaskSchedulerAdapters,
    private readonly locks: Locks | undefined,
    tasks: readonly AnyScheduledTask[],
    private readonly options: ScheduledTaskSchedulerOptions,
  ) {
    validateSchedulerOptions(options);
    this.now = options.now ?? (() => new Date());
    this.reportError = options.reportError ?? (() => undefined);
    this.sleep = options.sleep ?? abortableDelay;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.resolvedTasks = resolveTasks(tasks, adapters, locks, options);
  }

  /** Reconciles definitions and starts admission polling until stopped. */
  public async start(): Promise<void> {
    if (this.loopPromise !== undefined) {
      throw new Error("The scheduled task scheduler is already running.");
    }

    await this.initialize();
    this.handlerAbortController = new AbortController();
    this.loopAbortController = new AbortController();
    this.loopPromise = this.runLoop(this.loopAbortController.signal)
      .finally(() => {
        this.loopPromise = undefined;
        this.loopAbortController = undefined;
      });
  }

  /** Stops admission, aborts cooperative handlers and drains active runs. */
  public async stop(): Promise<void> {
    this.loopAbortController?.abort();
    this.handlerAbortController.abort();
    await this.loopPromise;
    await Promise.allSettled([...this.activeInvocations]);
  }

  /** Admits one cycle and waits for the runs started by that cycle. */
  public async runOnce(): Promise<number> {
    await this.initialize();
    const invocations = await this.admitOnce();
    await Promise.all(invocations);
    return invocations.length;
  }

  private initialize(): Promise<void> {
    this.initializePromise ??= this.reconcile();
    return this.initializePromise;
  }

  private async reconcile(): Promise<void> {
    const now = this.now();
    const tasksByAdapter = Map.groupBy(
      this.resolvedTasks,
      (resolved) => resolved.adapter,
    );

    await Promise.all([...tasksByAdapter].map(([adapter, tasks]) =>
      adapter.reconcile(tasks.map(({ task }) => ({
        taskId: task.id,
        nextScheduledAt: task.schedule.initial(now),
      })))
    ));
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.admitOnce();
      } catch (error) {
        this.reportError(error);
      }

      try {
        await this.sleep(this.pollIntervalMs, signal);
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
      }
    }
  }

  private admitOnce(): Promise<readonly Promise<void>[]> {
    if (this.admissionCycle !== undefined) {
      return this.admissionCycle;
    }

    const cycle = this.executeAdmissionCycle().finally(() => {
      if (this.admissionCycle === cycle) {
        this.admissionCycle = undefined;
      }
    });
    this.admissionCycle = cycle;
    return cycle;
  }

  private async executeAdmissionCycle(): Promise<readonly Promise<void>[]> {
    const capacity = this.options.slots - this.activeInvocations.size;
    if (capacity <= 0 || this.resolvedTasks.length === 0) {
      return [];
    }

    const statesByTask = await this.loadStates();
    const now = this.now();
    const candidates = this.resolvedTasks.flatMap((resolved) => {
      const state = statesByTask.get(resolved.task.id);
      const scheduledAt = state === undefined
        ? undefined
        : earliestDate(
            state.manualRunRequestedAt,
            state.paused ? undefined : state.nextScheduledAt,
          );

      return scheduledAt === undefined || scheduledAt > now
        ? []
        : [{ resolved, scheduledAt }];
    }).sort((left, right) =>
      left.scheduledAt.getTime() - right.scheduledAt.getTime()
      || left.resolved.task.id.localeCompare(right.resolved.task.id)
    ).slice(0, capacity);
    const invocations: Promise<void>[] = [];

    // Admission is serialized per cycle so slot accounting stays deterministic.
    for (const candidate of candidates) {
      const started = await this.tryStart(
        candidate.resolved,
        candidate.scheduledAt,
        now,
      );

      if (started !== undefined) {
        invocations.push(started.invocation);
      }
    }

    return invocations;
  }

  private async loadStates(): Promise<Map<string, ScheduledTaskState>> {
    const tasksByAdapter = Map.groupBy(
      this.resolvedTasks,
      (resolved) => resolved.adapter,
    );
    const groups = await Promise.all([...tasksByAdapter].map(
      async ([adapter, tasks]) => adapter.listStates(
        tasks.map(({ task }) => task.id),
      ),
    ));

    return new Map(groups.flat().map((state) => [state.taskId, state]));
  }

  private async tryStart(
    resolved: ResolvedTask,
    scheduledAt: Date,
    now: Date,
  ): Promise<{ invocation: Promise<void> } | undefined> {
    const { task, adapter } = resolved;
    const nextScheduledAt = task.schedule.kind === "loop"
      ? undefined
      : task.schedule.next({ scheduledAt, completedAt: now });
    const request: ReserveScheduledTaskRequest = {
      taskId: task.id,
      expectedScheduledAt: scheduledAt,
      ...(nextScheduledAt === undefined ? {} : { nextScheduledAt }),
      overlap: task.overlap,
      leaseMs: this.options.leaseMs,
    };
    const locallyActive = (this.activeTaskCounts.get(task.id) ?? 0) > 0;

    if (
      resolved.coordination === "local"
      && task.overlap !== "parallel"
      && locallyActive
    ) {
      if (task.overlap === "skip") {
        await adapter.skip(request);
      }
      return undefined;
    }

    const lock = await this.acquireOverlapLock(resolved);

    if (resolved.coordination === "distributed" && task.overlap !== "parallel") {
      if (lock === undefined) {
        if (task.overlap === "skip") {
          await adapter.skip(request);
        }
        return undefined;
      }
    }

    try {
      const result = await adapter.reserve(request);

      if (result.status !== "reserved") {
        await lock?.release();
        return undefined;
      }

      const invocation = this.runInvocation(resolved, result.reservation, lock)
        .catch((error: unknown) => {
          // Invocation errors are contained so one task cannot stop admission.
          this.reportError(error);
        });
      this.activeInvocations.add(invocation);
      this.activeTaskCounts.set(
        task.id,
        (this.activeTaskCounts.get(task.id) ?? 0) + 1,
      );
      void invocation.finally(() => {
        this.activeInvocations.delete(invocation);
        const remaining = (this.activeTaskCounts.get(task.id) ?? 1) - 1;
        if (remaining === 0) {
          this.activeTaskCounts.delete(task.id);
        } else {
          this.activeTaskCounts.set(task.id, remaining);
        }
      });
      return { invocation };
    } catch (error) {
      await lock?.release();
      throw error;
    }
  }

  private async acquireOverlapLock(
    resolved: ResolvedTask,
  ): Promise<LockHandle | undefined> {
    if (
      resolved.coordination !== "distributed"
      || resolved.task.overlap === "parallel"
    ) {
      return undefined;
    }

    return this.locks!.tryAcquire(
      `scheduled-task:${resolved.task.id}`,
      { ttlMs: this.options.leaseMs },
    );
  }

  private async runInvocation(
    resolved: ResolvedTask,
    reservation: ScheduledTaskReservation,
    lock: LockHandle | undefined,
  ): Promise<void> {
    const maintenance = this.keepOwnershipAlive(
      resolved.adapter,
      reservation,
      lock,
    );
    let execution: ExecutionScope<Config> | undefined;
    let error: unknown;
    let completedAt = this.now();
    let deferredDelayMs: number | undefined;

    try {
      execution = await this.app.createExecutionScope();
      if (
        execution.container.hasRegistration(
          setExecutionLogEnabledDependency.id,
        )
      ) {
        execution.container.resolve(setExecutionLogEnabledDependency)(
          resolved.task.executionLog,
        );
      }
      setExecutionLogContext(execution.context, {
        operation: resolved.task.id,
        transport: "scheduled-task",
        workload: "scheduled-tasks",
      });
      const observer = resolved.task.observe
        ? this.resolveObserver(execution)
        : undefined;
      const startedAt = performance.now();
      const deferral = createNextRunDeferral();
      let outcome: "failure" | "success" = "failure";

      await this.app.runInObservationContext(observer, async () => {
        observer?.record(executionStartedObservation, {
          operation: resolved.task.id,
          transport: "scheduled-task",
        });

        try {
          const dependencies = execution!.container.resolveDependencies(
            resolved.task.dependencies,
          );
          await resolved.task.handler(dependencies, {
            signal: this.handlerAbortController.signal,
            scheduledAt: reservation.scheduledAt,
            trigger: reservation.trigger,
            deferNextRun: deferral.deferNextRun,
          });
          outcome = "success";
        } catch (handlerError) {
          error = handlerError;
        } finally {
          completedAt = this.now();
          deferredDelayMs = deferral.delayMs;
          observer?.record(
            executionCompletedObservation,
            {
              operation: resolved.task.id,
              transport: "scheduled-task",
              ...getExecutionObservationContext(execution!.context),
              ...(error === undefined
                ? {}
                : getExecutionObservationError(error)),
            },
            {
              outcome,
              durationMs: performance.now() - startedAt,
            },
          );
          await execution!.dispose(outcome);
        }
      });
    } catch (executionError) {
      error ??= executionError;
      completedAt = this.now();
      if (execution !== undefined) {
        // Disposal is idempotent when the observed callback already reached it.
        await execution.dispose("failure").catch(() => undefined);
      }
    } finally {
      try {
        await maintenance.close();
      } catch (maintenanceError) {
        error ??= maintenanceError;
      }
      const nextScheduledAt = reservation.trigger === "scheduled"
        && resolved.task.schedule.kind === "loop"
        ? resolved.task.schedule.next({
            scheduledAt: reservation.scheduledAt,
            completedAt,
          })
        : undefined;
      const postponeUntil = reservation.trigger === "scheduled"
        && deferredDelayMs !== undefined
        ? new Date(completedAt.getTime() + deferredDelayMs)
        : undefined;
      try {
        await resolved.adapter.complete({
          taskId: reservation.taskId,
          reservationToken: reservation.reservationToken,
          completedAt,
          ...(nextScheduledAt === undefined ? {} : { nextScheduledAt }),
          ...(postponeUntil === undefined ? {} : { postponeUntil }),
          outcome: error === undefined ? "success" : "failure",
          ...(error === undefined
            ? {}
            : { error: serializeScheduledTaskError(error) }),
        });
      } catch (completionError) {
        error ??= completionError;
      }

      try {
        await lock?.release();
      } catch (releaseError) {
        error ??= releaseError;
      }
    }

    if (error !== undefined) {
      this.reportError(error);
    }
  }

  private keepOwnershipAlive(
    adapter: ScheduledTaskAdapter,
    reservation: ScheduledTaskReservation,
    lock: LockHandle | undefined,
  ): { close(): Promise<void> } {
    let activeExtension: Promise<unknown> | undefined;
    let extensionError: unknown;
    const interval = setInterval(() => {
      if (activeExtension !== undefined) {
        return;
      }

      activeExtension = Promise.all([
        adapter.extendLease({
          taskId: reservation.taskId,
          reservationToken: reservation.reservationToken,
          leaseMs: this.options.leaseMs,
        }),
        lock?.extend(this.options.leaseMs),
      ]).catch((error: unknown) => {
        extensionError = error;
      }).finally(() => {
        activeExtension = undefined;
      });
    }, Math.max(1, Math.floor(this.options.leaseMs / 2)));
    interval.unref();

    return {
      close: async () => {
        clearInterval(interval);
        await activeExtension;
        if (extensionError !== undefined) {
          throw extensionError;
        }
      },
    };
  }

  private resolveObserver(
    execution: ExecutionScope<Config>,
  ): Observer | undefined {
    return execution.container.hasRegistration("observer")
      ? execution.container.resolve(observerDependency)
      : undefined;
  }
}

function resolveTasks(
  tasks: readonly AnyScheduledTask[],
  adapters: ScheduledTaskSchedulerAdapters,
  locks: Locks | undefined,
  options: ScheduledTaskSchedulerOptions,
): readonly ResolvedTask[] {
  const defaultRuntime = options.defaultRuntime ?? {
    state: "persistent",
    coordination: "distributed",
  };
  const memoryAdapter = adapters.memory ?? new MemoryScheduledTaskAdapter();
  const taskIds = new Set<string>();

  return tasks.map((task) => {
    if (taskIds.has(task.id)) {
      throw new TypeError(`Scheduled task ids must be unique: "${task.id}".`);
    }
    taskIds.add(task.id);

    if (
      options.allowTaskRuntimeOverrides === false
      && (task.runtime.state !== undefined
        || task.runtime.coordination !== undefined)
    ) {
      throw new TypeError(
        `Runtime overrides are disabled for scheduled task "${task.id}".`,
      );
    }

    const state = task.runtime.state ?? defaultRuntime.state;
    const coordination = task.runtime.coordination
      ?? defaultRuntime.coordination;
    const adapter = state === "memory" ? memoryAdapter : adapters.persistent;

    if (adapter === undefined) {
      throw new TypeError(
        `Scheduled task "${task.id}" requires a persistent adapter.`,
      );
    }
    if (coordination === "distributed" && locks === undefined) {
      throw new TypeError(
        `Scheduled task "${task.id}" requires distributed locks.`,
      );
    }

    return { task, adapter, state, coordination };
  });
}

function earliestDate(
  left: Date | undefined,
  right: Date | undefined,
): Date | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return left < right ? left : right;
}

function validateSchedulerOptions(options: ScheduledTaskSchedulerOptions): void {
  for (const [name, value] of [
    ["slots", options.slots],
    ["leaseMs", options.leaseMs],
    ["pollIntervalMs", options.pollIntervalMs ?? 1_000],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer.`);
    }
  }
}
