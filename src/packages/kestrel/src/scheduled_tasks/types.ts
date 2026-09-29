import type { ScheduledTaskOverlap } from "./task.js";

export interface ScheduledTaskError {
  name: string;
  message: string;
  stack?: string;
}

export interface ScheduledTaskRegistration {
  taskId: string;
  nextScheduledAt: Date;
}

export interface ScheduledTaskState {
  taskId: string;
  paused: boolean;
  nextScheduledAt?: Date;
  manualRunRequestedAt?: Date;
  activeRuns: number;
  lastStartedAt?: Date;
  lastCompletedAt?: Date;
  lastOutcome?: "failure" | "success";
  lastError?: ScheduledTaskError;
}

export interface ReserveScheduledTaskRequest {
  taskId: string;
  expectedScheduledAt: Date;
  nextScheduledAt?: Date;
  overlap: ScheduledTaskOverlap;
  leaseMs: number;
}

export interface ScheduledTaskReservation {
  taskId: string;
  reservationToken: string;
  scheduledAt: Date;
  reservedAt: Date;
  trigger: "manual" | "scheduled";
}

export type ReserveScheduledTaskResult =
  | { status: "contended" | "paused" | "stale" }
  | { status: "skipped" }
  | { status: "reserved"; reservation: ScheduledTaskReservation };

export interface ScheduledTaskReservationRef {
  taskId: string;
  reservationToken: string;
}

export interface CompleteScheduledTaskRequest
  extends ScheduledTaskReservationRef {
  completedAt: Date;
  nextScheduledAt?: Date;
  postponeUntil?: Date;
  outcome: "failure" | "success";
  error?: ScheduledTaskError;
}

export interface ExtendScheduledTaskLeaseRequest
  extends ScheduledTaskReservationRef {
  leaseMs: number;
}

export interface ScheduledTaskPruneOptions {
  limit?: number;
}

/** Persistent or process-local occurrence state used by the scheduler. */
export interface ScheduledTaskAdapter {
  reconcile(
    registrations: readonly ScheduledTaskRegistration[],
  ): Promise<void>;
  listStates(taskIds: readonly string[]): Promise<readonly ScheduledTaskState[]>;
  reserve(
    request: ReserveScheduledTaskRequest,
  ): Promise<ReserveScheduledTaskResult>;
  /** Consumes one exact occurrence when an external overlap guard is busy. */
  skip(request: ReserveScheduledTaskRequest): Promise<boolean>;
  complete(request: CompleteScheduledTaskRequest): Promise<boolean>;
  release(reservation: ScheduledTaskReservationRef): Promise<boolean>;
  extendLease(request: ExtendScheduledTaskLeaseRequest): Promise<boolean>;
  /** Restores and removes a bounded batch of globally expired run leases. */
  pruneExpiredRuns(options: ScheduledTaskPruneOptions): Promise<number>;
  requestRun(taskId: string): Promise<void>;
  setPaused(taskId: string, paused: boolean, resumeAt?: Date): Promise<void>;
}

/** Converts an arbitrary handler failure into bounded persisted metadata. */
export function serializeScheduledTaskError(
  error: unknown,
  maxStackLength = 8_000,
): ScheduledTaskError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined
        ? {}
        : { stack: error.stack.slice(0, maxStackLength) }),
    };
  }

  return { name: "Error", message: String(error) };
}
