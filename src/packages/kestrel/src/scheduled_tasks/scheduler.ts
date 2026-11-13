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

  // Stop is terminal, including when it happens before polling has started.
  private readonly stopController = new AbortController();

  private pollingLifetime: Promise<void> | undefined;

  private loopPromise: Promise<void> | undefined;

  private starting = false;

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

  private get admissionStopped(): boolean {
    return this.stopController.signal.aborted || this.app.shutdown.signal.aborted;
  }

  /** Current polling lifetime; ordinary cycle failures retain existing recovery. */
  public get completion(): Promise<void> | undefined { return this.pollingLifetime; }

  /** Reconciles definitions and starts admission polling until stopped. */
  public async start(): Promise<void> {
    if (this.admissionStopped) return;
    if (this.loopPromise !== undefined || this.starting) {
      throw new Error("The scheduled task scheduler is already running.");
    }

    // Claim startup before reconciliation can yield to another start/stop caller.
    this.starting = true;
    try {
      await this.initialize();
      if (this.admissionStopped) return;
      const signal = AbortSignal.any([this.stopController.signal, this.app.shutdown.signal]);
      this.loopPromise = this.runLoop(signal)
        .finally(() => {
          this.loopPromise = undefined;
        });
      this.pollingLifetime = this.loopPromise;
      void this.loopPromise.catch(() => undefined);
    } finally { this.starting = false; }
  }

  /** Stops admission, aborts cooperative handlers and drains active runs. */
  public async stop(): Promise<void> {
    this.stopController.abort();
    try {
      // Startup and one-shot admission can own adapter operations before a loop exists.
      await this.initializePromise?.catch(() => undefined);
      await this.admissionCycle?.catch(() => undefined);
      await this.loopPromise;
    }
    finally { await Promise.allSettled([...this.activeInvocations]); }
  }

  /** Admits one cycle and waits for the runs started by that cycle. */
  public async runOnce(): Promise<number> {
    if (this.admissionStopped) return 0;
    await this.initialize();
    const invocations = await this.admitOnce();
    await waitForCycleWork(invocations);
    return invocations.length;
  }

  private initialize(): Promise<void> {
    // Reconciliation may synchronously call back into admission; publish its owner first.
    this.initializePromise ??= Promise.resolve().then(() => this.reconcile());
    return this.initializePromise;
  }

  private async reconcile(): Promise<void> {
    const now = this.now();
    const tasksByAdapter = Map.groupBy(
      this.resolvedTasks,
      (resolved) => resolved.adapter,
    );

    await waitForCycleWork([...tasksByAdapter].map(async ([adapter, tasks]) =>
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
    if (this.admissionStopped) return [];
    const capacity = this.options.slots - this.activeInvocations.size;
    if (capacity <= 0 || this.resolvedTasks.length === 0) {
      return [];
    }

    const statesByTask = await this.loadStates();
    if (this.admissionStopped) return [];
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
    );
    const invocations: Promise<void>[] = [];

    // Only reservations consume slots. A blocked occurrence leaves capacity for its peers.
    for (const candidate of candidates) {
      if (this.admissionStopped || invocations.length >= capacity) break;
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
    const groups = await waitForCycleWork([...tasksByAdapter].map(
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
    let lockOwned = lock !== undefined;
    const releaseLock = async () => {
      if (lockOwned) {
        lockOwned = false;
        await lock!.release();
      }
    };

    if (this.admissionStopped) {
      await releaseLock();
      return undefined;
    }

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
        await releaseLock();
        return undefined;
      }

      if (this.admissionStopped) {
        // Undo a late reservation instead of handing a stopped scheduler new work.
        await adapter.release(result.reservation);
        await releaseLock();
        return undefined;
      }

      // The invocation now owns lock release, including its failure paths.
      lockOwned = false;
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
      const finishInvocation = () => {
        this.activeInvocations.delete(invocation);
        const remaining = (this.activeTaskCounts.get(task.id) ?? 1) - 1;
        if (remaining === 0) {
          this.activeTaskCounts.delete(task.id);
        } else {
          this.activeTaskCounts.set(task.id, remaining);
        }
      };
      // Observe reporter rejection as well so background polling retains no detached rejection.
      void invocation.then(finishInvocation, finishInvocation);
      return { invocation };
    } catch (error) {
      try { await releaseLock(); }
      catch (releaseError) {
        throw new AggregateError([error, releaseError], "Scheduled task admission and overlap lock release failed.");
      }
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
    let error: unknown;
    let failed = false;
    // Failure presence is separate from its value: JavaScript can throw undefined or null.
    const captureFailure = (failure: unknown): void => {
      if (!failed) {
        failed = true;
        error = failure;
      }
    };
    // Ownership failure cancels this invocation without cancelling sibling tasks.
    const invocationAbort = new AbortController();
    const signal = AbortSignal.any([
      this.stopController.signal,
      this.app.shutdown.signal,
      invocationAbort.signal,
    ]);
    const maintenance = this.keepOwnershipAlive(
      resolved.adapter,
      reservation,
      lock,
      signal,
      (failure) => {
        // AbortSignal normalizes undefined; retain the backend's raw cause separately.
        captureFailure(failure);
        invocationAbort.abort(failure);
      },
    );
    let execution: ExecutionScope<Config> | undefined;
    let completedAt = reservation.reservedAt;
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
          const dependencies = await execution!.container.resolveDependenciesAsync(
            resolved.task.dependencies,
          );
          // Scope setup can outlast shutdown or a failed ownership renewal.
          signal.throwIfAborted();
          await resolved.task.handler(dependencies, {
            signal,
            scheduledAt: reservation.scheduledAt,
            trigger: reservation.trigger,
            deferNextRun: deferral.deferNextRun,
          });
          if (invocationAbort.signal.aborted) throw invocationAbort.signal.reason;
          outcome = "success";
        } catch (handlerError) {
          captureFailure(handlerError);
        } finally {
          completedAt = this.now();
          deferredDelayMs = deferral.delayMs;
          observer?.record(
            executionCompletedObservation,
            {
              operation: resolved.task.id,
              transport: "scheduled-task",
              ...getExecutionObservationContext(execution!.context),
              ...(!failed
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
      captureFailure(executionError);
      completedAt = this.now();
      if (execution !== undefined) {
        // Disposal is idempotent when the observed callback already reached it.
        await execution.dispose("failure").catch(() => undefined);
      }
    } finally {
      await maintenance.close();
      try {
        // A failing schedule can leave the occurrence recoverable without retaining its lock.
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
        await resolved.adapter.complete({
          taskId: reservation.taskId,
          reservationToken: reservation.reservationToken,
          completedAt,
          ...(nextScheduledAt === undefined ? {} : { nextScheduledAt }),
          ...(postponeUntil === undefined ? {} : { postponeUntil }),
          outcome: failed ? "failure" : "success",
          ...(!failed
            ? {}
            : { error: serializeScheduledTaskError(error) }),
        });
      } catch (completionError) {
        captureFailure(completionError);
      }

      try {
        await lock?.release();
      } catch (releaseError) {
        captureFailure(releaseError);
      }
    }

    if (failed) throw error;
  }

  private keepOwnershipAlive(
    adapter: ScheduledTaskAdapter,
    reservation: ScheduledTaskReservation,
    lock: LockHandle | undefined,
    signal: AbortSignal,
    onFailure: (error: unknown) => void,
  ): { close(): Promise<void> } {
    let activeExtension: Promise<unknown> | undefined;
    const stop = () => clearInterval(interval);
    const interval = setInterval(() => {
      if (signal.aborted) { stop(); return; }
      if (activeExtension !== undefined) {
        return;
      }

      const attempt = (operation: () => Promise<unknown>) => Promise.resolve()
        .then(operation)
        .catch((error: unknown) => {
          // The invocation owns the first failure, including a nullish cause.
          onFailure(error);
        });
      // Detect lost ownership promptly, but retain every in-flight renewal until close.
      activeExtension = Promise.allSettled([
        attempt(async () => {
          const owned = await adapter.extendLease({
            taskId: reservation.taskId,
            reservationToken: reservation.reservationToken,
            leaseMs: this.options.leaseMs,
          });
          if (!owned) throw new Error(`Scheduled task reservation ownership was lost for "${reservation.taskId}".`);
        }),
        attempt(async () => lock?.extend(this.options.leaseMs)),
      ]).then(() => undefined).finally(() => {
        activeExtension = undefined;
      });
    }, Math.max(1, Math.floor(this.options.leaseMs / 2)));
    interval.unref();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();

    return {
      close: async () => {
        clearInterval(interval);
        signal.removeEventListener("abort", stop);
        await activeExtension;
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

/** Retains every operation owned by the cycle, even after one rejects. */
async function waitForCycleWork<Result>(operations: readonly Promise<Result>[]): Promise<Result[]> {
  try {
    return await Promise.all(operations);
  } catch (error) {
    await Promise.allSettled(operations);
    throw error;
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
