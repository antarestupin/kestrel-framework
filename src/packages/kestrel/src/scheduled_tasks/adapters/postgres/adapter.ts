import {
  and,
  eq,
  sql,
} from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";

import { uuidV7 } from "../../../utils/uuid.js";
import {
  scheduledTaskRuns,
  scheduledTaskStates,
} from "./schema.js";
import type {
  CompleteScheduledTaskRequest,
  ExtendScheduledTaskLeaseRequest,
  ReserveScheduledTaskRequest,
  ReserveScheduledTaskResult,
  ScheduledTaskAdapter,
  ScheduledTaskRegistration,
  ScheduledTaskPruneOptions,
  ScheduledTaskReservationRef,
  ScheduledTaskError,
  ScheduledTaskState,
} from "../../types.js";

export type PostgresScheduledTaskDatabase = PgDatabase<
  NodePgQueryResultHKT,
  Record<string, unknown>
>;

interface LockedStateRow {
  task_id: string;
  paused: boolean;
  next_scheduled_at: Date | string | null;
  manual_run_requested_at: Date | string | null;
}

interface StateRow extends LockedStateRow {
  active_runs: number;
  last_started_at: Date | string | null;
  last_completed_at: Date | string | null;
  last_outcome: "failure" | "success" | null;
  last_error: ScheduledTaskError | null;
}

/** PostgreSQL occurrence store using row locks and token-owned active runs. */
export class PostgresScheduledTaskAdapter implements ScheduledTaskAdapter {
  public constructor(
    private readonly database: PostgresScheduledTaskDatabase,
    private readonly statesTable: typeof scheduledTaskStates = scheduledTaskStates,
    private readonly runsTable: typeof scheduledTaskRuns = scheduledTaskRuns,
  ) {}

  public async reconcile(
    registrations: readonly ScheduledTaskRegistration[],
  ): Promise<void> {
    if (registrations.length === 0) {
      return;
    }

    await this.database.insert(this.statesTable).values(
      registrations.map((registration) => ({
        taskId: registration.taskId,
        nextScheduledAt: registration.nextScheduledAt,
      })),
    ).onConflictDoNothing({ target: this.statesTable.taskId });
  }

  public async listStates(
    taskIds: readonly string[],
  ): Promise<readonly ScheduledTaskState[]> {
    if (taskIds.length === 0) {
      return [];
    }

    await this.recoverExpiredRuns(taskIds);
    const result = await this.database.execute(sql`
      SELECT
        state.task_id,
        state.paused,
        state.next_scheduled_at,
        state.manual_run_requested_at,
        state.last_started_at,
        state.last_completed_at,
        state.last_outcome,
        state.last_error,
        count(run.reservation_token)::integer AS active_runs
      FROM ${this.statesTable} state
      LEFT JOIN ${this.runsTable} run
        ON run.task_id = state.task_id
      WHERE state.task_id IN ${taskIdList(taskIds)}
      GROUP BY state.task_id
    `);

    return (result.rows as unknown as StateRow[]).map(mapState);
  }

  public async reserve(
    request: ReserveScheduledTaskRequest,
  ): Promise<ReserveScheduledTaskResult> {
    validateReserveRequest(request);

    return this.database.transaction(async (transaction) => {
      await recoverExpiredRuns(transaction, this.statesTable, this.runsTable, [
        request.taskId,
      ]);
      const result = await transaction.execute(sql`
        SELECT
          task_id,
          paused,
          next_scheduled_at,
          manual_run_requested_at
        FROM ${this.statesTable}
        WHERE task_id = ${request.taskId}
        FOR UPDATE
      `);
      const state = (result.rows as unknown as LockedStateRow[])[0];

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

      const reservationToken = uuidV7();
      const reservedAt = new Date();
      await consumeOccurrence(
        transaction,
        this.statesTable,
        request,
        trigger,
        reservedAt,
      );
      const [run] = await transaction.insert(this.runsTable).values({
        taskId: request.taskId,
        reservationToken,
        scheduledAt: request.expectedScheduledAt,
        reservedAt: sql`statement_timestamp()`,
        expiresAt: sql`statement_timestamp() + (${request.leaseMs} * interval '1 millisecond')`,
        trigger,
      }).returning({ reservedAt: this.runsTable.reservedAt });

      if (run === undefined) {
        throw new Error("PostgreSQL did not return the scheduled task run.");
      }

      return {
        status: "reserved",
        reservation: {
          taskId: request.taskId,
          reservationToken,
          scheduledAt: request.expectedScheduledAt,
          reservedAt: run.reservedAt,
          trigger,
        },
      };
    });
  }

  public async complete(
    request: CompleteScheduledTaskRequest,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [run] = await transaction.delete(this.runsTable).where(and(
        eq(this.runsTable.taskId, request.taskId),
        eq(this.runsTable.reservationToken, request.reservationToken),
      )).returning({ trigger: this.runsTable.trigger });

      if (run === undefined) {
        return false;
      }

      const requestedNext = run.trigger === "scheduled"
        ? request.nextScheduledAt
        : undefined;
      const nextScheduledAt = laterDate(
        requestedNext,
        request.postponeUntil,
      );
      await transaction.update(this.statesTable).set({
        lastCompletedAt: request.completedAt,
        lastOutcome: request.outcome,
        lastError: request.error ?? null,
        updatedAt: sql`statement_timestamp()`,
        ...(nextScheduledAt === undefined
          ? {}
          : {
              nextScheduledAt: sql`GREATEST(
                COALESCE(${this.statesTable.nextScheduledAt}, ${nextScheduledAt}),
                ${nextScheduledAt}
              )`,
            }),
      }).where(eq(this.statesTable.taskId, request.taskId));

      return true;
    });
  }

  public async skip(request: ReserveScheduledTaskRequest): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.execute(sql`
        SELECT
          task_id,
          paused,
          next_scheduled_at,
          manual_run_requested_at
        FROM ${this.statesTable}
        WHERE task_id = ${request.taskId}
        FOR UPDATE
      `);
      const state = (result.rows as unknown as LockedStateRow[])[0];

      if (state === undefined) {
        return false;
      }

      const trigger = getRequestedTrigger(state, request.expectedScheduledAt);
      if (trigger === undefined) {
        return false;
      }
      if (state.paused && trigger === "scheduled") {
        return false;
      }

      const [active] = await transaction
        .select({ count: sql<number>`count(*)::integer` })
        .from(this.runsTable)
        .where(eq(this.runsTable.taskId, request.taskId));
      if ((active?.count ?? 0) === 0) {
        // Avoid consuming an occurrence while another scheduler is between
        // acquiring the overlap lock and persisting its reservation.
        return false;
      }

      await consumeOccurrence(
        transaction,
        this.statesTable,
        request,
        trigger,
      );
      return true;
    });
  }

  public async release(
    reservation: ScheduledTaskReservationRef,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [run] = await transaction.delete(this.runsTable).where(and(
        eq(this.runsTable.taskId, reservation.taskId),
        eq(this.runsTable.reservationToken, reservation.reservationToken),
      )).returning({
        scheduledAt: this.runsTable.scheduledAt,
        trigger: this.runsTable.trigger,
      });

      if (run === undefined) {
        return false;
      }

      await restoreRuns(
        transaction,
        this.statesTable,
        reservation.taskId,
        [run],
      );
      return true;
    });
  }

  public async extendLease(
    request: ExtendScheduledTaskLeaseRequest,
  ): Promise<boolean> {
    const rows = await this.database.update(this.runsTable).set({
      expiresAt: sql`statement_timestamp() + (${request.leaseMs} * interval '1 millisecond')`,
    }).where(and(
      eq(this.runsTable.taskId, request.taskId),
      eq(this.runsTable.reservationToken, request.reservationToken),
    )).returning({ token: this.runsTable.reservationToken });

    return rows.length === 1;
  }

  public async pruneExpiredRuns(
    options: ScheduledTaskPruneOptions,
  ): Promise<number> {
    const limit = validatePruneLimit(options.limit ?? 1_000);

    return this.database.transaction((transaction) => recoverExpiredRuns(
      transaction,
      this.statesTable,
      this.runsTable,
      undefined,
      limit,
    ));
  }

  public async requestRun(taskId: string): Promise<void> {
    const rows = await this.database.update(this.statesTable).set({
      manualRunRequestedAt: sql`COALESCE(
        ${this.statesTable.manualRunRequestedAt},
        statement_timestamp()
      )`,
      updatedAt: sql`statement_timestamp()`,
    }).where(eq(this.statesTable.taskId, taskId)).returning({
      taskId: this.statesTable.taskId,
    });
    assertRegistered(rows, taskId);
  }

  public async setPaused(
    taskId: string,
    paused: boolean,
    resumeAt?: Date,
  ): Promise<void> {
    const rows = await this.database.update(this.statesTable).set({
      paused,
      ...(paused || resumeAt === undefined
        ? {}
        : { nextScheduledAt: resumeAt }),
      updatedAt: sql`statement_timestamp()`,
    }).where(eq(this.statesTable.taskId, taskId)).returning({
      taskId: this.statesTable.taskId,
    });
    assertRegistered(rows, taskId);
  }

  private recoverExpiredRuns(taskIds: readonly string[]): Promise<void> {
    return this.database.transaction(async (transaction) => {
      await recoverExpiredRuns(
        transaction,
        this.statesTable,
        this.runsTable,
        taskIds,
      );
    });
  }
}

type Transaction = Parameters<
  Parameters<PostgresScheduledTaskDatabase["transaction"]>[0]
>[0];

async function recoverExpiredRuns(
  transaction: Transaction,
  statesTable: typeof scheduledTaskStates,
  runsTable: typeof scheduledTaskRuns,
  taskIds: readonly string[] | undefined,
  limit?: number,
): Promise<number> {
  if (taskIds?.length === 0) {
    return 0;
  }

  const taskFilter = taskIds === undefined
    ? sql``
    : sql`AND run.task_id IN ${taskIdList(taskIds)}`;
  const limitClause = limit === undefined ? sql`` : sql`LIMIT ${limit}`;
  const result = await transaction.execute(sql`
    WITH candidates AS (
      SELECT run.reservation_token
      FROM ${runsTable} run
      WHERE run.expires_at <= statement_timestamp()
        ${taskFilter}
      ORDER BY run.expires_at, run.reservation_token
      ${limitClause}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM ${runsTable} run
    USING candidates
    WHERE run.reservation_token = candidates.reservation_token
    RETURNING run.task_id, run.scheduled_at, run.trigger
  `);
  const expired = (result.rows as unknown as {
    task_id: string;
    scheduled_at: Date | string;
    trigger: "manual" | "scheduled";
  }[]).map((run) => ({
    taskId: run.task_id,
    scheduledAt: toDate(run.scheduled_at),
    trigger: run.trigger,
  }));

  for (const [taskId, runs] of Map.groupBy(expired, (run) => run.taskId)) {
    await restoreRuns(transaction, statesTable, taskId, runs);
  }

  return expired.length;
}

async function restoreRuns(
  transaction: Transaction,
  statesTable: typeof scheduledTaskStates,
  taskId: string,
  runs: readonly {
    scheduledAt: Date;
    trigger: "manual" | "scheduled";
  }[],
): Promise<void> {
  const scheduledAt = earliest(runs
    .filter((run) => run.trigger === "scheduled")
    .map((run) => run.scheduledAt));
  const manualAt = earliest(runs
    .filter((run) => run.trigger === "manual")
    .map((run) => run.scheduledAt));

  await transaction.update(statesTable).set({
    ...(scheduledAt === undefined
      ? {}
      : {
          nextScheduledAt: sql`LEAST(
            COALESCE(${statesTable.nextScheduledAt}, ${scheduledAt}),
            ${scheduledAt}
          )`,
        }),
    ...(manualAt === undefined
      ? {}
      : {
          manualRunRequestedAt: sql`LEAST(
            COALESCE(${statesTable.manualRunRequestedAt}, ${manualAt}),
            ${manualAt}
          )`,
        }),
    updatedAt: sql`statement_timestamp()`,
  }).where(eq(statesTable.taskId, taskId));
}

async function consumeOccurrence(
  transaction: Transaction,
  statesTable: typeof scheduledTaskStates,
  request: ReserveScheduledTaskRequest,
  trigger: "manual" | "scheduled",
  startedAt?: Date,
): Promise<void> {
  await transaction.update(statesTable).set({
    ...(trigger === "manual"
      ? { manualRunRequestedAt: null }
      : { nextScheduledAt: request.nextScheduledAt ?? null }),
    ...(startedAt === undefined ? {} : { lastStartedAt: startedAt }),
    updatedAt: sql`statement_timestamp()`,
  }).where(eq(statesTable.taskId, request.taskId));
}

function getRequestedTrigger(
  state: LockedStateRow,
  expectedScheduledAt: Date,
): "manual" | "scheduled" | undefined {
  if (
    toOptionalDate(state.manual_run_requested_at)?.getTime()
      === expectedScheduledAt.getTime()
  ) {
    return "manual";
  }

  return toOptionalDate(state.next_scheduled_at)?.getTime()
      === expectedScheduledAt.getTime()
    ? "scheduled"
    : undefined;
}

function mapState(row: StateRow): ScheduledTaskState {
  return {
    taskId: row.task_id,
    paused: row.paused,
    activeRuns: row.active_runs,
    ...(row.next_scheduled_at === null
      ? {}
      : { nextScheduledAt: toDate(row.next_scheduled_at) }),
    ...(row.manual_run_requested_at === null
      ? {}
      : { manualRunRequestedAt: toDate(row.manual_run_requested_at) }),
    ...(row.last_started_at === null
      ? {}
      : { lastStartedAt: toDate(row.last_started_at) }),
    ...(row.last_completed_at === null
      ? {}
      : { lastCompletedAt: toDate(row.last_completed_at) }),
    ...(row.last_outcome === null ? {} : { lastOutcome: row.last_outcome }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

function toOptionalDate(value: Date | string | null): Date | undefined {
  return value === null ? undefined : toDate(value);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function taskIdList(taskIds: readonly string[]) {
  return sql`(${sql.join(taskIds.map((taskId) => sql`${taskId}`), sql`, `)})`;
}

function laterDate(
  left: Date | undefined,
  right: Date | undefined,
): Date | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return left > right ? left : right;
}

function earliest(dates: readonly Date[]): Date | undefined {
  return dates.reduce<Date | undefined>(
    (current, date) => current === undefined || date < current ? date : current,
    undefined,
  );
}

function assertRegistered(
  rows: readonly { taskId: string }[],
  taskId: string,
): void {
  if (rows.length === 0) {
    throw new Error(`Scheduled task "${taskId}" is not registered.`);
  }
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
