import { uuidV7 } from "../../../utils/uuid.js";
import type {
  CompleteScheduledTaskRequest,
  ExtendScheduledTaskLeaseRequest,
  ReserveScheduledTaskRequest,
  ReserveScheduledTaskResult,
  ScheduledTaskAdapter,
  ScheduledTaskRegistration,
  ScheduledTaskPruneOptions,
  ScheduledTaskReservationRef,
  ScheduledTaskState,
} from "../../types.js";

interface StoredState extends Omit<ScheduledTaskState, "activeRuns"> {}

interface StoredRun {
  taskId: string;
  reservationToken: string;
  scheduledAt: Date;
  reservedAt: Date;
  expiresAt: Date;
  trigger: "manual" | "scheduled";
}

export interface MemoryScheduledTaskAdapterOptions {
  now?: () => Date;
  createReservationToken?: () => string;
}

/** Process-local occurrence state with the same reservation semantics as PostgreSQL. */
export class MemoryScheduledTaskAdapter implements ScheduledTaskAdapter {
  private readonly states = new Map<string, StoredState>();

  private readonly runs = new Map<string, StoredRun>();

  private readonly now: () => Date;

  private readonly createReservationToken: () => string;

  public constructor(options: MemoryScheduledTaskAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createReservationToken = options.createReservationToken ?? uuidV7;
  }

  public async reconcile(
    registrations: readonly ScheduledTaskRegistration[],
  ): Promise<void> {
    for (const registration of registrations) {
      if (!this.states.has(registration.taskId)) {
        this.states.set(registration.taskId, {
          taskId: registration.taskId,
          paused: false,
          nextScheduledAt: new Date(registration.nextScheduledAt),
        });
      }
    }
  }

  public async listStates(
    taskIds: readonly string[],
  ): Promise<readonly ScheduledTaskState[]> {
    this.recoverExpiredRuns();

    return taskIds.flatMap((taskId) => {
      const state = this.states.get(taskId);

      return state === undefined ? [] : [{
        ...cloneState(state),
        activeRuns: this.activeRuns(taskId),
      }];
    });
  }

  public async reserve(
    request: ReserveScheduledTaskRequest,
  ): Promise<ReserveScheduledTaskResult> {
    validateReserveRequest(request);
    this.recoverExpiredRuns();
    const state = this.states.get(request.taskId);

    if (state === undefined) {
      return { status: state === undefined ? "stale" : "paused" };
    }

    const trigger = getRequestedTrigger(state, request.expectedScheduledAt);

    if (trigger === undefined) {
      return { status: "stale" };
    }
    if (state.paused && trigger === "scheduled") {
      return { status: "paused" };
    }

    const now = this.now();
    const reservationToken = this.createReservationToken();
    consumeOccurrence(state, trigger, request.nextScheduledAt);
    state.lastStartedAt = now;
    this.runs.set(reservationToken, {
      taskId: request.taskId,
      reservationToken,
      scheduledAt: new Date(request.expectedScheduledAt),
      reservedAt: now,
      expiresAt: new Date(now.getTime() + request.leaseMs),
      trigger,
    });

    return {
      status: "reserved",
      reservation: {
        taskId: request.taskId,
        reservationToken,
        scheduledAt: new Date(request.expectedScheduledAt),
        reservedAt: now,
        trigger,
      },
    };
  }

  public async complete(
    request: CompleteScheduledTaskRequest,
  ): Promise<boolean> {
    const run = this.getOwnedRun(request);

    if (run === undefined) {
      return false;
    }

    const state = this.states.get(request.taskId);
    if (state === undefined) {
      return false;
    }

    this.runs.delete(request.reservationToken);
    state.lastCompletedAt = new Date(request.completedAt);
    state.lastOutcome = request.outcome;
    if (request.error === undefined) {
      delete state.lastError;
    } else {
      state.lastError = request.error;
    }

    if (run.trigger === "scheduled" && request.nextScheduledAt !== undefined) {
      state.nextScheduledAt = laterDate(
        state.nextScheduledAt,
        request.nextScheduledAt,
      );
    }

    if (request.postponeUntil !== undefined) {
      state.nextScheduledAt = laterDate(
        state.nextScheduledAt,
        request.postponeUntil,
      );
    }

    return true;
  }

  public async skip(request: ReserveScheduledTaskRequest): Promise<boolean> {
    const state = this.states.get(request.taskId);

    if (state === undefined || this.activeRuns(request.taskId) === 0) {
      return false;
    }

    const trigger = getRequestedTrigger(state, request.expectedScheduledAt);
    if (trigger === undefined) {
      return false;
    }
    if (state.paused && trigger === "scheduled") {
      return false;
    }

    consumeOccurrence(state, trigger, request.nextScheduledAt);
    return true;
  }

  public async release(
    reservation: ScheduledTaskReservationRef,
  ): Promise<boolean> {
    const run = this.getOwnedRun(reservation);

    if (run === undefined) {
      return false;
    }

    this.runs.delete(reservation.reservationToken);
    this.restoreOccurrence(run);
    return true;
  }

  public async extendLease(
    request: ExtendScheduledTaskLeaseRequest,
  ): Promise<boolean> {
    const run = this.getOwnedRun(request);

    if (run === undefined) {
      return false;
    }

    run.expiresAt = new Date(this.now().getTime() + request.leaseMs);
    return true;
  }

  public async pruneExpiredRuns(
    options: ScheduledTaskPruneOptions,
  ): Promise<number> {
    const limit = validatePruneLimit(options.limit ?? 1_000);
    const now = this.now();
    const expired = [...this.runs.values()]
      .filter((run) => run.expiresAt.getTime() <= now.getTime())
      .sort((left, right) =>
        left.expiresAt.getTime() - right.expiresAt.getTime()
        || left.reservationToken.localeCompare(right.reservationToken)
      )
      .slice(0, limit);

    for (const run of expired) {
      this.runs.delete(run.reservationToken);
      this.restoreOccurrence(run);
    }

    return expired.length;
  }

  public async requestRun(taskId: string): Promise<void> {
    const state = this.requireState(taskId);
    state.manualRunRequestedAt ??= this.now();
  }

  public async setPaused(
    taskId: string,
    paused: boolean,
    resumeAt?: Date,
  ): Promise<void> {
    const state = this.requireState(taskId);
    state.paused = paused;

    if (!paused && resumeAt !== undefined) {
      state.nextScheduledAt = new Date(resumeAt);
    }
  }

  /** Exposes deterministic snapshots for adapter and scheduler tests. */
  public inspectStates(): readonly ScheduledTaskState[] {
    this.recoverExpiredRuns();
    return [...this.states.values()].map((state) => ({
      ...cloneState(state),
      activeRuns: this.activeRuns(state.taskId),
    }));
  }

  private activeRuns(taskId: string): number {
    return [...this.runs.values()].filter((run) => run.taskId === taskId).length;
  }

  private getOwnedRun(
    reference: ScheduledTaskReservationRef,
  ): StoredRun | undefined {
    const run = this.runs.get(reference.reservationToken);
    return run?.taskId === reference.taskId ? run : undefined;
  }

  private recoverExpiredRuns(): void {
    const now = this.now();

    for (const run of this.runs.values()) {
      if (run.expiresAt.getTime() <= now.getTime()) {
        this.runs.delete(run.reservationToken);
        this.restoreOccurrence(run);
      }
    }
  }

  private restoreOccurrence(run: StoredRun): void {
    const state = this.states.get(run.taskId);

    if (state === undefined) {
      return;
    }

    if (run.trigger === "manual") {
      state.manualRunRequestedAt = laterDate(
        state.manualRunRequestedAt,
        run.scheduledAt,
      );
    } else {
      state.nextScheduledAt = earlierDate(
        state.nextScheduledAt,
        run.scheduledAt,
      );
    }
  }

  private requireState(taskId: string): StoredState {
    const state = this.states.get(taskId);

    if (state === undefined) {
      throw new Error(`Scheduled task "${taskId}" is not registered.`);
    }

    return state;
  }
}

function getRequestedTrigger(
  state: StoredState,
  expectedScheduledAt: Date,
): "manual" | "scheduled" | undefined {
  if (
    state.manualRunRequestedAt?.getTime() === expectedScheduledAt.getTime()
  ) {
    return "manual";
  }

  return state.nextScheduledAt?.getTime() === expectedScheduledAt.getTime()
    ? "scheduled"
    : undefined;
}

function consumeOccurrence(
  state: StoredState,
  trigger: "manual" | "scheduled",
  nextScheduledAt: Date | undefined,
): void {
  if (trigger === "manual") {
    delete state.manualRunRequestedAt;
    return;
  }

  if (nextScheduledAt === undefined) {
    delete state.nextScheduledAt;
  } else {
    state.nextScheduledAt = new Date(nextScheduledAt);
  }
}

function cloneState(state: StoredState): StoredState {
  return {
    ...state,
    ...(state.nextScheduledAt === undefined
      ? {}
      : { nextScheduledAt: new Date(state.nextScheduledAt) }),
    ...(state.manualRunRequestedAt === undefined
      ? {}
      : { manualRunRequestedAt: new Date(state.manualRunRequestedAt) }),
    ...(state.lastStartedAt === undefined
      ? {}
      : { lastStartedAt: new Date(state.lastStartedAt) }),
    ...(state.lastCompletedAt === undefined
      ? {}
      : { lastCompletedAt: new Date(state.lastCompletedAt) }),
  };
}

function laterDate(
  current: Date | undefined,
  candidate: Date,
): Date {
  return current === undefined || candidate > current
    ? new Date(candidate)
    : current;
}

function earlierDate(
  current: Date | undefined,
  candidate: Date,
): Date {
  return current === undefined || candidate < current
    ? new Date(candidate)
    : current;
}

function validateReserveRequest(request: ReserveScheduledTaskRequest): void {
  if (!Number.isInteger(request.leaseMs) || request.leaseMs <= 0) {
    throw new TypeError("leaseMs must be a positive integer.");
  }
}

function validatePruneLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("Scheduled task prune limit must be a positive integer.");
  }

  return limit;
}
