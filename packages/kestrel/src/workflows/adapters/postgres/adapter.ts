import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  and,
  asc,
  desc,
  eq,
  gte,
  getTableColumns,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { alias, type PgDatabase } from "drizzle-orm/pg-core";

import type {
  CommitWorkflowActivationRequest,
  ContinueWorkflowAsNewRequest,
  CompleteExternalWorkflowActivityRequest,
  CompleteWorkflowActivityRequest,
  ExtendWorkflowTaskLeaseRequest,
  LoadedWorkflowActivation,
  ReservedWorkflowTask,
  ReservedWorkflowActivityDispatch,
  ReserveWorkflowActivityDispatchesRequest,
  ReserveWorkflowTasksRequest,
  RetryWorkflowTaskRequest,
  RetryWorkflowExecutionRequest,
  RetryWorkflowActivityDispatchRequest,
  SendWorkflowSignalRequest,
  StartWorkflowExecutionRequest,
  StartWorkflowExecutionResult,
  WorkflowAdapter,
  WorkflowExecution,
  WorkflowExecutionPage,
  WorkflowExecutionQuery,
  WorkflowExecutionVersionSummary,
  WorkflowHistoryArchive,
  RecoverVersionBlockedExecutionRequest,
  WorkflowSignalReceipt,
  WorkflowTaskReservationRef,
  WorkflowActivityDispatchMode,
  WorkflowActivityDispatchReservationRef,
} from "../../adapter.js";
import { isTerminalWorkflowStatus } from "../../adapter.js";
import { decodeWorkflowExecutionCursor, workflowExecutionCursorCodec } from "../../execution_cursor.js";
import {
  type WorkflowExecutionError,
  WorkflowExecutionClosedError,
  WorkflowConcurrencyConflictError,
  WorkflowExecutionConflictError,
  WorkflowExecutionNotFoundError,
  WorkflowJournalConflictError,
  WorkflowSignalConflictError,
} from "../../errors.js";
import type {
  WorkflowActivationSnapshot,
  WorkflowHistoryEvent,
} from "../../history.js";
import type { WorkflowPayload } from "../../serialization.js";
import type { ResolvedWorkflowConcurrency } from "../../concurrency.js";
import {
  workflowExecutions,
  workflowDispatchOutbox,
  workflowHistoryEvents,
  workflowHistoryArchives,
  workflowSignals,
  workflowTasks,
} from "./schema.js";

export type PostgresWorkflowDatabase = PgDatabase<
  NodePgQueryResultHKT,
  Record<string, unknown>
>;

export interface PostgresWorkflowAdapterOptions {
  terminalPollIntervalMs?: number;
  activityDispatchMode?: WorkflowActivityDispatchMode;
}

interface ReservedTaskRow {
  id: string;
  execution_id: string;
  workflow_name: string;
  workflow_version: number;
  history_generation: number;
  root_execution_id: string;
  parent_execution_id: string | null;
  kind: "activity" | "timer" | "workflow";
  command_sequence: number | null;
  target: string | null;
  payload: WorkflowPayload | null;
  attempt: number;
  available_at: Date;
  reserved_at: Date;
  reservation_token: string;
  created_at: Date;
}

interface ReservedDispatchRow {
  id: string;
  execution_id: string;
  command_sequence: number;
  target: string;
  payload: WorkflowPayload | null;
  attempt: number;
  available_at: Date;
  reserved_at: Date;
  reservation_token: string;
  created_at: Date;
}

interface SerializedHistoryRow {
  execution_id: string;
  event_index: number;
  type: typeof workflowHistoryEvents.$inferSelect.type;
  command_sequence: number | null;
  completion_order: number | null;
  command_kind: string | null;
  target: string | null;
  signal_id: string | null;
  signal_name: string | null;
  payload: WorkflowPayload | null;
  payload_present: boolean;
  error: WorkflowExecutionError | null;
  source_id: string | null;
  occurred_at: string;
}

interface SerializedWorkflowExecution {
  id: string;
  workflow_name: string;
  workflow_version: number;
  history_generation: number;
  input: WorkflowPayload | null;
  status: WorkflowExecution["status"];
  output: WorkflowPayload | null;
  output_present: boolean;
  error: WorkflowExecutionError | null;
  cancellation_requested: boolean;
  paused_at: string | null;
  parent_execution_id: string | null;
  parent_command_sequence: number | null;
  root_execution_id: string;
  retry_of_execution_id: string | null;
  definition_concurrency_limit: number | null;
  concurrency_key: string | null;
  concurrency_key_limit: number | null;
  concurrency_conflict: "enqueue" | "reject" | "return-existing" | null;
  concurrency_scope: "active-work" | "execution" | null;
  concurrency_admitted: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface StartBatchResultRow {
  request_order: number;
  decision: "create" | "execution-conflict" | "existing" | "reject"
    | "return-existing";
  execution: SerializedWorkflowExecution | null;
}

interface NormalizedStartBatch {
  uniqueRequests: readonly StartWorkflowExecutionRequest[];
  originals: readonly {
    uniqueIndex: number;
    firstOccurrence: boolean;
  }[];
}

/** PostgreSQL workflow journal with token-owned atomic transitions. */
export class PostgresWorkflowAdapter implements WorkflowAdapter {
  public readonly activityDispatchMode: WorkflowActivityDispatchMode;

  private readonly terminalPollIntervalMs: number;

  public constructor(
    private readonly database: PostgresWorkflowDatabase,
    options: PostgresWorkflowAdapterOptions = {},
    private readonly executionsTable: typeof workflowExecutions = workflowExecutions,
    private readonly historyTable: typeof workflowHistoryEvents = workflowHistoryEvents,
    private readonly tasksTable: typeof workflowTasks = workflowTasks,
    private readonly signalsTable: typeof workflowSignals = workflowSignals,
    private readonly dispatchOutboxTable: typeof workflowDispatchOutbox =
      workflowDispatchOutbox,
    private readonly historyArchivesTable: typeof workflowHistoryArchives =
      workflowHistoryArchives,
  ) {
    this.terminalPollIntervalMs = options.terminalPollIntervalMs ?? 25;
    this.activityDispatchMode = options.activityDispatchMode ?? "embedded";
  }

  public async start(
    request: StartWorkflowExecutionRequest,
  ): Promise<StartWorkflowExecutionResult> {
    const [result] = await this.startMany([request]);
    return result!;
  }

  public async startMany(
    requests: readonly StartWorkflowExecutionRequest[],
  ): Promise<readonly StartWorkflowExecutionResult[]> {
    if (requests.length === 0) return [];
    const batch = normalizeStartBatch(requests);
    validateStartConcurrencyGroups(batch.uniqueRequests);
    const lockKeys = getStartLockKeys(batch.uniqueRequests);
    const lockValues = sql.join(lockKeys.map((key) => sql`(${key}::text)`), sql`, `);
    const requestValues = startRequestValues(batch.uniqueRequests);

    const uniqueResults = await this.database.transaction(async (transaction) => {
      // Locks must be a separate statement so the decision query receives a
      // fresh READ COMMITTED snapshot after any contending starter commits.
      await transaction.execute(sql`
        SELECT pg_advisory_xact_lock(hashtextextended(locks.lock_key, 0))
        FROM (
          SELECT DISTINCT requested.lock_key
          FROM (VALUES ${lockValues}) requested(lock_key)
          ORDER BY requested.lock_key
        ) locks
      `);
      const result = await transaction.execute(sql`
        WITH requested(
          request_order,
          execution_id,
          workflow_name,
          workflow_version,
          input,
          root_execution_id,
          parent_execution_id,
          parent_command_sequence,
          definition_limit,
          concurrency_key,
          concurrency_key_limit,
          concurrency_conflict,
          concurrency_scope
        ) AS (
          VALUES ${requestValues}
        ),
        inspected AS MATERIALIZED (
          SELECT
            requested.*,
            existing.id AS existing_id,
            existing.workflow_name AS existing_workflow_name,
            CASE
              WHEN existing.initial_input IS NULL THEN existing.input
              ELSE existing.initial_input->'value'
            END AS existing_initial_input,
            COALESCE(key_state.active_count, 0)::integer AS external_count,
            COALESCE(key_state.admitted_count, 0)::integer
              AS external_admitted_count,
            key_state.chosen_execution_id AS external_chosen_execution_id
          FROM requested
          LEFT JOIN ${this.executionsTable} existing
            ON existing.id = requested.execution_id
          LEFT JOIN LATERAL (
            SELECT
              count(*)::integer AS active_count,
              count(*) FILTER (
                WHERE candidate.concurrency_admitted
              )::integer AS admitted_count,
              (array_agg(
                candidate.id
                ORDER BY
                  candidate.concurrency_admitted DESC,
                  candidate.created_at,
                  candidate.id
              ))[1] AS chosen_execution_id
            FROM ${this.executionsTable} candidate
            WHERE requested.concurrency_key IS NOT NULL
              AND candidate.workflow_name = requested.workflow_name
              AND candidate.concurrency_key = requested.concurrency_key
              AND candidate.status NOT IN (
                'cancelled', 'completed', 'failed', 'terminated'
              )
          ) key_state ON requested.concurrency_key IS NOT NULL
        ),
        positioned AS (
          SELECT
            inspected.*,
            COALESCE(sum(
              CASE WHEN inspected.existing_id IS NULL THEN 1 ELSE 0 END
            ) OVER (
              PARTITION BY
                inspected.workflow_name,
                COALESCE(
                  inspected.concurrency_key,
                  inspected.execution_id
                )
              ORDER BY inspected.request_order
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
            ), 0)::integer AS prior_new_count
          FROM inspected
        ),
        decided AS MATERIALIZED (
          SELECT
            positioned.*,
            CASE
              WHEN positioned.existing_id IS NOT NULL
                AND (
                  positioned.existing_workflow_name
                    IS DISTINCT FROM positioned.workflow_name
                  OR positioned.existing_initial_input
                    IS DISTINCT FROM positioned.input
                ) THEN 'execution-conflict'
              WHEN positioned.existing_id IS NOT NULL THEN 'existing'
              WHEN positioned.concurrency_key IS NOT NULL
                AND positioned.external_count + positioned.prior_new_count
                  >= positioned.concurrency_key_limit
                AND positioned.concurrency_conflict = 'reject' THEN 'reject'
              WHEN positioned.concurrency_key IS NOT NULL
                AND positioned.external_count + positioned.prior_new_count
                  >= positioned.concurrency_key_limit
                AND positioned.concurrency_conflict = 'return-existing'
                THEN 'return-existing'
              ELSE 'create'
            END AS decision,
            CASE
              WHEN positioned.existing_id IS NOT NULL
                THEN positioned.existing_id
              WHEN positioned.concurrency_key IS NOT NULL
                AND positioned.external_count + positioned.prior_new_count
                  >= positioned.concurrency_key_limit
                AND positioned.concurrency_conflict = 'return-existing'
                THEN COALESCE(
                  positioned.external_chosen_execution_id,
                  (
                    SELECT earlier.execution_id
                    FROM positioned earlier
                    WHERE earlier.request_order < positioned.request_order
                      AND earlier.existing_id IS NULL
                      AND earlier.workflow_name = positioned.workflow_name
                      AND earlier.concurrency_key
                        = positioned.concurrency_key
                    ORDER BY earlier.request_order
                    LIMIT 1
                  )
                )
              ELSE NULL
            END AS attached_execution_id
          FROM positioned
        ),
        creations AS MATERIALIZED (
          SELECT
            decided.*,
            decided.concurrency_key IS NULL
              OR decided.concurrency_scope IS DISTINCT FROM 'execution'
              OR decided.external_admitted_count + decided.prior_new_count
                < decided.concurrency_key_limit AS admitted
          FROM decided
          WHERE decided.decision = 'create'
        ),
        created AS (
          INSERT INTO ${this.executionsTable} (
            id,
            workflow_name,
            workflow_version,
            history_generation,
            input,
            initial_input,
            status,
            root_execution_id,
            parent_execution_id,
            parent_command_sequence,
            definition_concurrency_limit,
            concurrency_key,
            concurrency_key_limit,
            concurrency_conflict,
            concurrency_scope,
            concurrency_admitted,
            revision,
            created_at,
            updated_at
          )
          SELECT
            creations.execution_id,
            creations.workflow_name,
            creations.workflow_version,
            1,
            creations.input,
            jsonb_build_object('value', creations.input),
            CASE WHEN creations.admitted THEN 'queued' ELSE 'pending' END,
            creations.root_execution_id,
            creations.parent_execution_id,
            creations.parent_command_sequence,
            creations.definition_limit,
            creations.concurrency_key,
            creations.concurrency_key_limit,
            creations.concurrency_conflict,
            creations.concurrency_scope,
            creations.admitted,
            0,
            statement_timestamp(),
            statement_timestamp()
          FROM creations
          ORDER BY creations.request_order
          RETURNING *
        ),
        created_activations AS (
          INSERT INTO ${this.tasksTable} (execution_id, kind)
          SELECT created.id, 'workflow'
          FROM created
          WHERE created.concurrency_admitted
          ON CONFLICT DO NOTHING
          RETURNING id
        )
        SELECT
          decided.request_order,
          decided.decision,
          COALESCE(to_jsonb(created), to_jsonb(attached)) AS execution,
          (SELECT count(*) FROM created_activations) AS activation_count
        FROM decided
        LEFT JOIN created
          ON created.id = CASE
            WHEN decided.decision = 'create' THEN decided.execution_id
            WHEN decided.decision = 'return-existing'
              THEN decided.attached_execution_id
            ELSE NULL
          END
        LEFT JOIN ${this.executionsTable} attached
          ON attached.id = CASE
            WHEN decided.decision = 'existing' THEN decided.existing_id
            WHEN decided.decision = 'return-existing'
              THEN decided.attached_execution_id
            ELSE NULL
          END
        ORDER BY decided.request_order
      `);
      const rows = result.rows as unknown as StartBatchResultRow[];
      const conflict = rows.find((row) => row.decision === "execution-conflict");
      if (conflict !== undefined) {
        throw new WorkflowExecutionConflictError(
          batch.uniqueRequests[conflict.request_order]!.executionId,
        );
      }
      const rejected = rows.find((row) => row.decision === "reject");
      if (rejected !== undefined) {
        const request = batch.uniqueRequests[rejected.request_order]!;
        throw new WorkflowConcurrencyConflictError(
          request.workflowName,
          request.concurrency!.keyed!.key,
        );
      }
      if (rows.length !== batch.uniqueRequests.length) {
        throw new Error("PostgreSQL returned an incomplete workflow start batch.");
      }

      return rows.map((row) => {
        if (row.execution === null) {
          throw new Error("PostgreSQL did not resolve a workflow start request.");
        }
        return {
          execution: mapSerializedExecution(row.execution),
          created: row.decision === "create",
        };
      });
    });

    return batch.originals.map(({ uniqueIndex, firstOccurrence }) => {
      const result = uniqueResults[uniqueIndex]!;
      return firstOccurrence
        ? result
        : { execution: result.execution, created: false };
    });
  }

  public async get(executionId: string): Promise<WorkflowExecution | undefined> {
    const [execution] = await this.database.select()
      .from(this.executionsTable)
      .where(eq(this.executionsTable.id, executionId));
    return execution === undefined ? undefined : mapExecution(execution);
  }

  public async listExecutions(
    query: WorkflowExecutionQuery,
  ): Promise<WorkflowExecutionPage> {
    validateExecutionQuery(query);
    const predicates: SQL[] = [];

    if (query.workflowNames?.length) {
      predicates.push(inArray(this.executionsTable.workflowName, query.workflowNames));
    }
    if (query.workflowVersions?.length) {
      predicates.push(inArray(
        this.executionsTable.workflowVersion,
        query.workflowVersions,
      ));
    }
    if (query.statuses?.length) {
      predicates.push(inArray(this.executionsTable.status, query.statuses));
    }
    if (query.search !== undefined) {
      const pattern = `%${query.search}%`;
      predicates.push(or(
        ilike(this.executionsTable.id, pattern),
        ilike(this.executionsTable.workflowName, pattern),
        ilike(this.executionsTable.concurrencyKey, pattern),
      )!);
    }
    if (query.createdAfter !== undefined) {
      predicates.push(gte(this.executionsTable.createdAt, query.createdAfter));
    }
    if (query.createdBefore !== undefined) {
      predicates.push(lte(this.executionsTable.createdAt, query.createdBefore));
    }
    if (query.parentExecutionId !== undefined) {
      predicates.push(eq(
        this.executionsTable.parentExecutionId,
        query.parentExecutionId,
      ));
    }
    if (query.rootExecutionId !== undefined) {
      predicates.push(eq(this.executionsTable.rootExecutionId, query.rootExecutionId));
    }
    if (query.retryOfExecutionId !== undefined) {
      predicates.push(eq(
        this.executionsTable.retryOfExecutionId,
        query.retryOfExecutionId,
      ));
    }
    if (query.paused !== undefined) {
      predicates.push(query.paused
        ? isNotNull(this.executionsTable.pausedAt)
        : isNull(this.executionsTable.pausedAt));
    }

    if (query.cursor !== undefined) {
      const cursor = decodeWorkflowExecutionCursor(query.cursor);
      // Keep PostgreSQL microseconds in the comparison instead of encoding a Date.
      const createdAt = sql`${cursor.createdAt}::timestamptz`;
      predicates.push(or(
        lt(this.executionsTable.createdAt, createdAt),
        and(
          eq(this.executionsTable.createdAt, createdAt),
          lt(this.executionsTable.id, cursor.id),
        ),
      )!);
    }

    const rows = await this.database.select({
      ...getTableColumns(this.executionsTable),
      // Project exact UTC text for the boundary independently from public Date fields.
      cursorCreatedAt: sql<string>`to_char(${this.executionsTable.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
      .from(this.executionsTable)
      .where(predicates.length === 0 ? undefined : and(...predicates))
      .orderBy(
        desc(this.executionsTable.createdAt),
        desc(this.executionsTable.id),
      )
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(mapExecution);
    return {
      items,
      ...(hasMore && items.length > 0
        ? { nextCursor: z.encode(workflowExecutionCursorCodec, {
          id: items.at(-1)!.executionId,
          createdAt: rows[items.length - 1]!.cursorCreatedAt,
        }) }
        : {}),
    };
  }

  public async waitForTerminal(executionId: string): Promise<WorkflowExecution> {
    for (;;) {
      const execution = await this.get(executionId);

      if (execution === undefined) {
        throw new WorkflowExecutionNotFoundError(executionId);
      }

      if (isTerminalWorkflowStatus(execution.status)) {
        return execution;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, this.terminalPollIntervalMs));
    }
  }

  public async sendSignal(
    request: SendWorkflowSignalRequest,
  ): Promise<WorkflowSignalReceipt> {
    return this.database.transaction(async (transaction) => {
      const [execution] = await transaction.select()
        .from(this.executionsTable)
        .where(eq(this.executionsTable.id, request.executionId))
        .for("update");

      if (execution === undefined) {
        throw new WorkflowExecutionNotFoundError(request.executionId);
      }

      if (execution.workflowName !== request.workflowName) {
        throw new WorkflowExecutionConflictError(request.executionId);
      }

      if (request.idempotencyKey !== undefined) {
        const [existing] = await transaction.select()
          .from(this.signalsTable)
          .where(and(
            eq(this.signalsTable.executionId, request.executionId),
            eq(this.signalsTable.idempotencyKey, request.idempotencyKey),
          ));

        if (existing !== undefined) {
          if (
            existing.name !== request.signalName
            || !isDeepStrictEqual(existing.payload ?? null, request.payload)
          ) {
            throw new WorkflowSignalConflictError(
              request.executionId,
              request.idempotencyKey,
            );
          }

          return { id: existing.id, accepted: false };
        }
      }

      if (isTerminalWorkflowStatus(execution.status)) {
        throw new WorkflowExecutionClosedError(request.executionId);
      }

      const [signal] = await transaction.insert(this.signalsTable).values({
        executionId: request.executionId,
        name: request.signalName,
        payload: request.payload,
        ...(request.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: request.idempotencyKey }),
      }).returning();

      if (signal === undefined) {
        throw new Error("PostgreSQL did not return the stored workflow signal.");
      }

      await transaction.insert(this.historyTable).values({
        executionId: request.executionId,
        eventIndex: execution.revision,
        type: "signal-received",
        signalId: signal.id,
        signalName: signal.name,
        payload: signal.payload ?? null,
        payloadPresent: true,
        occurredAt: signal.receivedAt,
      });
      await transaction.update(this.executionsTable).set({
        revision: execution.revision + 1,
        updatedAt: sql`statement_timestamp()`,
      }).where(eq(this.executionsTable.id, request.executionId));
      await transaction.insert(this.tasksTable).values({
        executionId: request.executionId,
        kind: "workflow",
      }).onConflictDoNothing();

      return { id: signal.id, accepted: true };
    });
  }

  public async reserveTasks(
    request: ReserveWorkflowTasksRequest,
  ): Promise<readonly ReservedWorkflowTask[]> {
    validateReservationRequest(request);

    if (request.kinds.length === 0) {
      return [];
    }

    const kinds = sql.join(
      request.kinds.map((kind) => sql`${kind}::text`),
      sql`, `,
    );
    const result = await this.database.execute(sql`
      WITH ranked AS MATERIALIZED (
        SELECT
          task.id,
          execution.workflow_name,
          execution.definition_concurrency_limit,
          execution.concurrency_key,
          execution.concurrency_key_limit,
          execution.concurrency_scope,
          row_number() OVER (
            PARTITION BY task.execution_id, task.kind
            ORDER BY task.available_at, task.created_at, task.id
          ) AS execution_rank,
          row_number() OVER (
            PARTITION BY execution.workflow_name
            ORDER BY task.available_at, task.created_at, task.id
          ) AS definition_rank,
          row_number() OVER (
            PARTITION BY execution.workflow_name, execution.concurrency_key
            ORDER BY task.available_at, task.created_at, task.id
          ) AS keyed_rank
        FROM ${this.tasksTable} task
        INNER JOIN ${this.executionsTable} execution
          ON execution.id = task.execution_id
        WHERE task.kind IN (${kinds})
          AND task.available_at <= statement_timestamp()
          AND execution.status IN ('queued', 'running', 'waiting')
          AND execution.paused_at IS NULL
          AND (
            task.kind <> 'workflow'
            OR NOT EXISTS (
              SELECT 1
              FROM ${this.tasksTable} active
              WHERE active.execution_id = task.execution_id
                AND active.kind = 'workflow'
                AND active.id <> task.id
                AND active.reservation_token IS NOT NULL
                AND active.available_at > statement_timestamp()
            )
          )
      ),
      selected AS MATERIALIZED (
        SELECT task.id
        FROM ${this.tasksTable} task
        INNER JOIN ranked ON ranked.id = task.id
        WHERE (task.kind <> 'workflow' OR ranked.execution_rank = 1)
          AND (
            ranked.definition_concurrency_limit IS NULL
            OR ranked.definition_rank <= ranked.definition_concurrency_limit - (
              SELECT count(*)
              FROM ${this.tasksTable} active_task
              INNER JOIN ${this.executionsTable} active_execution
                ON active_execution.id = active_task.execution_id
              WHERE active_execution.workflow_name = ranked.workflow_name
                AND active_task.reservation_token IS NOT NULL
                AND active_task.available_at > statement_timestamp()
            )
          )
          AND (
            ranked.concurrency_scope IS DISTINCT FROM 'active-work'
            OR ranked.concurrency_key IS NULL
            OR ranked.keyed_rank <= ranked.concurrency_key_limit - (
              SELECT count(*)
              FROM ${this.tasksTable} active_task
              INNER JOIN ${this.executionsTable} active_execution
                ON active_execution.id = active_task.execution_id
              WHERE active_execution.workflow_name = ranked.workflow_name
                AND active_execution.concurrency_key = ranked.concurrency_key
                AND active_task.reservation_token IS NOT NULL
                AND active_task.available_at > statement_timestamp()
            )
          )
        ORDER BY task.available_at, task.created_at, task.id
        FOR UPDATE OF task SKIP LOCKED
        LIMIT ${request.limit}
      ),
      reserved AS (
        UPDATE ${this.tasksTable} task
        SET
          available_at = statement_timestamp()
            + (${request.leaseMs} * interval '1 millisecond'),
          reserved_at = statement_timestamp(),
          reservation_token = uuidv7(),
          attempt = task.attempt + 1
        FROM selected
        WHERE task.id = selected.id
        RETURNING task.*
      ),
      running AS (
        UPDATE ${this.executionsTable} execution
        SET status = 'running', updated_at = statement_timestamp()
        FROM reserved
        WHERE reserved.kind = 'workflow'
          AND execution.id = reserved.execution_id
        RETURNING execution.id
      )
      SELECT
        reserved.*,
        execution.workflow_name,
        execution.workflow_version,
        execution.history_generation,
        execution.root_execution_id,
        execution.parent_execution_id
      FROM reserved
      INNER JOIN ${this.executionsTable} execution
        ON execution.id = reserved.execution_id
      ORDER BY reserved.available_at, reserved.created_at, reserved.id
    `);

    return (result.rows as unknown as ReservedTaskRow[]).map(mapReservedTask);
  }

  public async loadActivations(
    reservations: readonly WorkflowTaskReservationRef[],
  ): Promise<readonly LoadedWorkflowActivation[]> {
    if (reservations.length === 0) return [];

    // Correlated aggregation preserves one row per activation and permits row
    // locks while loading every history in a single driver round trip. Omitting
    // an OF list keeps this valid for schema-qualified production tables:
    // PostgreSQL only accepts unqualified relation names after FOR SHARE OF.
    const rows = await this.database.select({
      taskId: this.tasksTable.id,
      execution: this.executionsTable,
      history: sql<readonly SerializedHistoryRow[]>`COALESCE((
        SELECT jsonb_agg(to_jsonb(history_row) ORDER BY history_row.event_index)
        FROM ${this.historyTable} history_row
        WHERE history_row.execution_id = ${this.tasksTable.executionId}
      ), '[]'::jsonb)`,
    }).from(this.tasksTable)
      .innerJoin(
        this.executionsTable,
        eq(this.executionsTable.id, this.tasksTable.executionId),
      )
      .where(and(
        eq(this.tasksTable.kind, "workflow"),
        or(...reservations.map((reservation) => and(
          eq(this.tasksTable.id, reservation.taskId),
          eq(this.tasksTable.reservationToken, reservation.reservationToken),
        ))),
      ))
      .for("share");

    return rows.map(({ taskId, execution, history }) => ({
      taskId,
      snapshot: {
        executionId: execution.id,
        workflowName: execution.workflowName,
        workflowVersion: execution.workflowVersion,
        historyGeneration: execution.historyGeneration,
        input: execution.input ?? null,
        revision: execution.revision,
        history: history.map(mapSerializedHistoryEvent),
        cancellationRequested: execution.cancellationRequested,
      },
    }));
  }

  public async commitActivation(
    request: CommitWorkflowActivationRequest,
  ): Promise<boolean> {
    const fastPathCommitted = await this.tryCommitActivationFastPath(request);
    if (fastPathCommitted) return true;

    return this.database.transaction(async (transaction) => {
      // PostgreSQL requires unqualified relation names after `FOR UPDATE OF`.
      // Explicit aliases keep the lock query valid for schema-qualified tables.
      const lockedTask = alias(this.tasksTable, "workflow_task");
      const lockedExecution = alias(
        this.executionsTable,
        "workflow_execution",
      );
      // Lock and validate both durable rows while deriving journal counters in
      // one statement. The revision check below remains the optimistic CAS.
      const [state] = await transaction.select({
        execution: lockedExecution,
        scheduledCount: sql<number>`(
          SELECT count(*)::integer
          FROM ${this.historyTable} scheduled_history
          WHERE scheduled_history.execution_id = ${request.executionId}
            AND scheduled_history.type = 'command-scheduled'
        )`,
        completionCount: sql<number>`(
          SELECT count(*)::integer
          FROM ${this.historyTable} completed_history
          WHERE completed_history.execution_id = ${request.executionId}
            AND completed_history.type = 'command-completed'
        )`,
      }).from(lockedTask)
        .innerJoin(
          lockedExecution,
          eq(lockedExecution.id, lockedTask.executionId),
        )
        .where(and(
          eq(lockedTask.id, request.taskId),
          eq(lockedTask.reservationToken, request.reservationToken),
          eq(lockedTask.kind, "workflow"),
          eq(lockedTask.executionId, request.executionId),
        ))
        .for("update", { of: [lockedTask, lockedExecution] });

      if (state === undefined) return false;
      const execution = state.execution;

      if (execution.revision !== request.expectedRevision) {
        throw new WorkflowJournalConflictError(
          request.executionId,
          request.expectedRevision,
          execution.revision,
        );
      }

      const scheduledCount = state.scheduledCount;
      const now = new Date();
      let nextRevision = execution.revision;
      let completionOrder = state.completionCount;
      let completedSynchronously = false;

      for (const [offset, command] of request.commands.entries()) {
        const expectedSequence = scheduledCount + offset;

        if (command.sequence !== expectedSequence) {
          throw new TypeError(
            `Expected workflow command sequence ${expectedSequence}, received ${command.sequence}.`,
          );
        }

        await transaction.insert(this.historyTable).values({
          executionId: request.executionId,
          eventIndex: nextRevision,
          type: "command-scheduled",
          commandSequence: command.sequence,
          commandKind: command.kind,
          target: command.target,
          payload: command.payload,
          payloadPresent: true,
          occurredAt: now,
        });
        nextRevision += 1;

        if (command.kind === "activity") {
          if (this.activityDispatchMode === "outbox") {
            await transaction.insert(this.dispatchOutboxTable).values({
              executionId: request.executionId,
              commandSequence: command.sequence,
              target: command.target,
              transport: "worker",
              payload: command.payload,
            });
          } else {
            await transaction.insert(this.tasksTable).values({
              executionId: request.executionId,
              kind: "activity",
              commandSequence: command.sequence,
              target: command.target,
              payload: command.payload,
            });
          }
        } else if (command.kind === "timer") {
          await transaction.insert(this.tasksTable).values({
            executionId: request.executionId,
            kind: "timer",
            commandSequence: command.sequence,
            target: "sleep",
            payload: command.payload,
            availableAt: new Date(now.getTime() + readNumber(
              command.payload,
              "durationMs",
            )),
          });
        } else if (command.kind === "signal") {
          const timeoutMs = readOptionalNumber(command.payload, "timeoutMs");

          if (timeoutMs !== undefined) {
            await transaction.insert(this.tasksTable).values({
              executionId: request.executionId,
              kind: "timer",
              commandSequence: command.sequence,
              target: `signal:${command.target}`,
              payload: command.payload,
              availableAt: new Date(now.getTime() + timeoutMs),
            });
          }
        } else if (command.kind === "capture") {
          await transaction.insert(this.historyTable).values({
            executionId: request.executionId,
            eventIndex: nextRevision,
            type: "command-completed",
            commandSequence: command.sequence,
            completionOrder,
            payload: command.payload,
            payloadPresent: true,
            occurredAt: now,
          });
          nextRevision += 1;
          completionOrder += 1;
          completedSynchronously = true;
        } else if (command.kind === "child") {
          const childId = readOptionalString(command.payload, "executionId")
            ?? `${request.executionId}:${command.sequence}`;
          const concurrency = readOptionalConcurrency(command.payload);
          const keyed = concurrency?.keyed;
          let concurrencyAdmitted = true;

          if (keyed?.scope === "execution") {
            await transaction.execute(sql`
              SELECT pg_advisory_xact_lock(
                hashtextextended(
                  ${`workflow-key:${command.target}:${keyed.key}`},
                  0
                )
              )
            `);
            const [{ count: admitted = 0 } = {}] = await transaction.select({
              count: sql<number>`count(*)::integer`,
            }).from(this.executionsTable).where(and(
              eq(this.executionsTable.workflowName, command.target),
              eq(this.executionsTable.concurrencyKey, keyed.key),
              eq(this.executionsTable.concurrencyAdmitted, true),
              sql`${this.executionsTable.status} NOT IN ('cancelled', 'completed', 'failed', 'terminated')`,
            ));
            concurrencyAdmitted = admitted < keyed.limit;
          }

          const [createdChild] = await transaction.insert(this.executionsTable).values({
            id: childId,
            workflowName: command.target,
            workflowVersion: readNumber(command.payload, "version"),
            input: readPayload(command.payload, "input"),
            initialInput: {
              value: readPayload(command.payload, "input"),
            },
            status: concurrencyAdmitted ? "queued" : "pending",
            parentExecutionId: request.executionId,
            parentCommandSequence: command.sequence,
            rootExecutionId: execution.rootExecutionId,
            concurrencyAdmitted,
            ...(concurrency?.definitionLimit === undefined
              ? {}
              : {
                  definitionConcurrencyLimit: concurrency.definitionLimit,
                }),
            ...(keyed === undefined
              ? {}
              : {
                  concurrencyKey: keyed.key,
                  concurrencyKeyLimit: keyed.limit,
                  concurrencyConflict: "enqueue",
                  concurrencyScope: keyed.scope,
                }),
          }).onConflictDoNothing({ target: this.executionsTable.id }).returning();

          if (createdChild === undefined) {
            const [existingChild] = await transaction.select()
              .from(this.executionsTable)
              .where(eq(this.executionsTable.id, childId));

            if (
              existingChild === undefined
              || existingChild.workflowName !== command.target
              || existingChild.workflowVersion !== readNumber(command.payload, "version")
              || existingChild.parentExecutionId !== request.executionId
              || existingChild.parentCommandSequence !== command.sequence
              || !isDeepStrictEqual(
                existingChild.input,
                readPayload(command.payload, "input"),
              )
            ) {
              throw new WorkflowExecutionConflictError(childId);
            }
          }

          if (concurrencyAdmitted) {
            await transaction.insert(this.tasksTable).values({
              executionId: childId,
              kind: "workflow",
            }).onConflictDoNothing();
          }
        } else {
          throw new TypeError(`Unsupported workflow command kind "${command.kind}".`);
        }
      }

      const durableHistory = await transaction.select()
        .from(this.historyTable)
        .where(eq(this.historyTable.executionId, request.executionId))
        .orderBy(asc(this.historyTable.eventIndex));
      const completedSequences = new Set(durableHistory
        .filter((event) => event.type === "command-completed")
        .map((event) => event.commandSequence));
      const hasPendingSignal = durableHistory.some((event) =>
        event.type === "command-scheduled"
        && event.commandKind === "signal"
        && event.commandSequence !== null
        && !completedSequences.has(event.commandSequence));
      // Most activations do not wait for signals, so avoid touching the signal
      // table unless the durable history contains an unsettled signal command.
      const bufferedSignals = hasPendingSignal
        ? await transaction.select()
          .from(this.signalsTable)
          .where(and(
            eq(this.signalsTable.executionId, request.executionId),
            sql`${this.signalsTable.consumedAt} IS NULL`,
          ))
          .orderBy(asc(this.signalsTable.receivedAt))
        : [];
      const usedSignalIds = new Set<string>();

      for (const pending of durableHistory) {
        if (
          pending.type !== "command-scheduled"
          || pending.commandKind !== "signal"
          || pending.commandSequence === null
          || pending.target === null
          || completedSequences.has(pending.commandSequence)
        ) {
          continue;
        }

        const signal = bufferedSignals.find((candidate) =>
          candidate.name === pending.target && !usedSignalIds.has(candidate.id));

        if (signal === undefined) {
          continue;
        }

        usedSignalIds.add(signal.id);
        await transaction.update(this.signalsTable).set({
          consumedAt: sql`statement_timestamp()`,
        }).where(eq(this.signalsTable.id, signal.id));
        await transaction.insert(this.historyTable).values({
          executionId: request.executionId,
          eventIndex: nextRevision,
          type: "command-completed",
          commandSequence: pending.commandSequence,
          completionOrder,
          payload: signal.payload ?? null,
          payloadPresent: true,
          sourceId: signal.id,
          occurredAt: now,
        });
        await transaction.delete(this.tasksTable).where(and(
          eq(this.tasksTable.executionId, request.executionId),
          eq(this.tasksTable.commandSequence, pending.commandSequence),
        ));
        nextRevision += 1;
        completionOrder += 1;
        completedSynchronously = true;
      }

      const terminal = request.outcome.status === "completed"
        || request.outcome.status === "failed"
        || request.outcome.status === "cancelled";
      await transaction.update(this.executionsTable).set({
        status: completedSynchronously && !terminal
          && request.outcome.status !== "blocked"
          ? "queued"
          : request.outcome.status,
        revision: nextRevision,
        ...(terminal ? { concurrencyAdmitted: false } : {}),
        updatedAt: sql`statement_timestamp()`,
        ...(terminal ? { completedAt: sql`statement_timestamp()` } : {}),
        ...(request.outcome.status === "completed"
          ? request.outcome.output === undefined
            ? { outputPresent: false }
            : { output: request.outcome.output, outputPresent: true }
          : request.outcome.status === "failed"
            || request.outcome.status === "blocked"
            ? { error: request.outcome.error }
            : {}),
      }).where(eq(this.executionsTable.id, request.executionId));

      if (execution.cancellationRequested && request.commands.length > 0) {
        await transaction.delete(this.tasksTable).where(and(
          eq(this.tasksTable.executionId, request.executionId),
          sql`${this.tasksTable.commandSequence} < ${request.commands[0]!.sequence}`,
        ));
      }
      await transaction.delete(this.tasksTable).where(and(
        eq(this.tasksTable.id, request.taskId),
        eq(this.tasksTable.reservationToken, request.reservationToken),
      ));

      if (terminal) {
        await transaction.delete(this.tasksTable).where(
          eq(this.tasksTable.executionId, request.executionId),
        );

        // A parent does not leave children running after its own terminal path.
        const children = await transaction.select({ id: this.executionsTable.id })
          .from(this.executionsTable)
          .where(eq(this.executionsTable.parentExecutionId, request.executionId));

        for (const child of children) {
          await this.cancelExecutionTree(
            transaction as PostgresWorkflowDatabase,
            child.id,
          );
        }
      }

      if (completedSynchronously && !terminal && request.outcome.status !== "blocked") {
        await transaction.insert(this.tasksTable).values({
          executionId: request.executionId,
          kind: "workflow",
        }).onConflictDoNothing();
      }

      if (terminal && execution.parentExecutionId !== null
        && execution.parentCommandSequence !== null) {
        const [parent] = await transaction.select()
          .from(this.executionsTable)
          .where(eq(this.executionsTable.id, execution.parentExecutionId))
          .for("update");

        if (parent !== undefined && !isTerminalWorkflowStatus(parent.status)) {
          const [{ count: parentCompletionOrder = 0 } = {}] = await transaction
            .select({ count: sql<number>`count(*)::integer` })
            .from(this.historyTable)
            .where(and(
              eq(this.historyTable.executionId, parent.id),
              eq(this.historyTable.type, "command-completed"),
            ));
          const [completion] = await transaction.insert(this.historyTable).values({
            executionId: parent.id,
            eventIndex: parent.revision,
            type: "command-completed",
            commandSequence: execution.parentCommandSequence,
            completionOrder: parentCompletionOrder,
            ...(request.outcome.status === "completed"
              ? request.outcome.output === undefined
                ? { payloadPresent: false }
                : { payload: request.outcome.output, payloadPresent: true }
              : {
                  error: request.outcome.status === "failed"
                    ? request.outcome.error
                    : {
                      name: "WorkflowCancellationError",
                      message: `Child workflow "${execution.id}" was cancelled.`,
                      details: { executionId: execution.id },
                    },
                }),
          }).onConflictDoNothing().returning({
            eventIndex: this.historyTable.eventIndex,
          });

          if (completion !== undefined) {
            await transaction.update(this.executionsTable).set({
              revision: parent.revision + 1,
              status: "queued",
              updatedAt: sql`statement_timestamp()`,
            }).where(eq(this.executionsTable.id, parent.id));
            await transaction.insert(this.tasksTable).values({
              executionId: parent.id,
              kind: "workflow",
            }).onConflictDoNothing();
          }
        }
      }

      if (terminal) {
        await this.admitPendingKeyedExecutions(
          transaction as PostgresWorkflowDatabase,
          execution,
        );
      }

      return true;
    });
  }

  /** Uses bounded single-statement transitions before the generic journal path. */
  private async tryCommitActivationFastPath(
    request: CommitWorkflowActivationRequest,
  ): Promise<boolean> {
    const [command] = request.commands;

    if (
      request.commands.length === 1
      && request.outcome.status === "waiting"
      && command !== undefined
      && (command.kind === "activity" || command.kind === "timer")
    ) {
      return this.tryCommitStandardCommand(request, command);
    }

    if (
      request.commands.length === 0
      && (
        request.outcome.status === "completed"
        || request.outcome.status === "failed"
        || request.outcome.status === "cancelled"
      )
    ) {
      return this.tryCommitSimpleTerminal(request);
    }

    return false;
  }

  /** Atomically journals and dispatches one ordinary activity or timer. */
  private async tryCommitStandardCommand(
    request: CommitWorkflowActivationRequest,
    command: CommitWorkflowActivationRequest["commands"][number],
  ): Promise<boolean> {
    if (command.kind !== "activity" && command.kind !== "timer") return false;
    const payload = sql.param(command.payload, this.historyTable.payload);
    const createdWork = command.kind === "activity"
      ? this.activityDispatchMode === "outbox"
        ? sql`
          INSERT INTO ${this.dispatchOutboxTable} (
            execution_id,
            command_sequence,
            target,
            transport,
            payload
          )
          SELECT
            scheduled_command.execution_id,
            ${command.sequence},
            ${command.target},
            'worker',
            ${sql.param(command.payload, this.dispatchOutboxTable.payload)}
          FROM scheduled_command
          RETURNING execution_id
        `
        : sql`
          INSERT INTO ${this.tasksTable} (
            execution_id,
            kind,
            command_sequence,
            target,
            payload
          )
          SELECT
            scheduled_command.execution_id,
            'activity',
            ${command.sequence},
            ${command.target},
            ${sql.param(command.payload, this.tasksTable.payload)}
          FROM scheduled_command
          RETURNING execution_id
        `
      : sql`
        INSERT INTO ${this.tasksTable} (
          execution_id,
          kind,
          command_sequence,
          target,
          payload,
          available_at
        )
        SELECT
          scheduled_command.execution_id,
          'timer',
          ${command.sequence},
          'sleep',
          ${sql.param(command.payload, this.tasksTable.payload)},
          statement_timestamp()
            + (${readNumber(command.payload, "durationMs")} * interval '1 millisecond')
        FROM scheduled_command
        RETURNING execution_id
      `;
    const result = await this.database.execute(sql`
      WITH validated AS MATERIALIZED (
        SELECT
          workflow_task.id AS task_id,
          workflow_task.execution_id,
          workflow_execution.revision
        FROM ${this.tasksTable} workflow_task
        INNER JOIN ${this.executionsTable} workflow_execution
          ON workflow_execution.id = workflow_task.execution_id
        WHERE workflow_task.id = ${request.taskId}::uuid
          AND workflow_task.reservation_token = ${request.reservationToken}::uuid
          AND workflow_task.kind = 'workflow'
          AND workflow_task.execution_id = ${request.executionId}
          AND workflow_execution.revision = ${request.expectedRevision}
          AND workflow_execution.cancellation_requested = false
          AND ${command.sequence} = (
            SELECT count(*)::integer
            FROM ${this.historyTable} scheduled_history
            WHERE scheduled_history.execution_id = workflow_task.execution_id
              AND scheduled_history.type = 'command-scheduled'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${this.historyTable} pending_signal
            WHERE pending_signal.execution_id = workflow_task.execution_id
              AND pending_signal.type = 'command-scheduled'
              AND pending_signal.command_kind = 'signal'
              AND NOT EXISTS (
                SELECT 1
                FROM ${this.historyTable} signal_completion
                WHERE signal_completion.execution_id = pending_signal.execution_id
                  AND signal_completion.type = 'command-completed'
                  AND signal_completion.command_sequence = pending_signal.command_sequence
              )
          )
        FOR UPDATE OF workflow_task, workflow_execution
      ),
      scheduled_command AS (
        INSERT INTO ${this.historyTable} (
          execution_id,
          event_index,
          type,
          command_sequence,
          command_kind,
          target,
          payload,
          payload_present,
          occurred_at
        )
        SELECT
          validated.execution_id,
          validated.revision,
          'command-scheduled',
          ${command.sequence},
          ${command.kind},
          ${command.target},
          ${payload},
          true,
          statement_timestamp()
        FROM validated
        RETURNING execution_id
      ),
      created_work AS (
        ${createdWork}
      ),
      updated_execution AS (
        UPDATE ${this.executionsTable} AS workflow_execution
        SET
          status = 'waiting',
          revision = validated.revision + 1,
          updated_at = statement_timestamp()
        FROM validated, created_work
        WHERE workflow_execution.id = validated.execution_id
          AND created_work.execution_id = validated.execution_id
        RETURNING workflow_execution.id
      ),
      deleted_activation AS (
        DELETE FROM ${this.tasksTable} AS workflow_task
        USING validated, updated_execution
        WHERE workflow_task.id = validated.task_id
          AND workflow_task.execution_id = updated_execution.id
        RETURNING workflow_task.id
      )
      SELECT EXISTS (SELECT 1 FROM deleted_activation) AS committed
    `);

    return result.rows[0]?.committed === true;
  }

  /** Completes a root execution when no children or queued successors exist. */
  private async tryCommitSimpleTerminal(
    request: CommitWorkflowActivationRequest,
  ): Promise<boolean> {
    const outcome = request.outcome;
    if (outcome.status === "blocked" || outcome.status === "waiting") return false;
    const completed = outcome.status === "completed";
    const hasOutput = completed && outcome.output !== undefined;
    const output = hasOutput
      ? outcome.output
      : null;
    const error = outcome.status === "failed"
      ? outcome.error
      : null;
    const result = await this.database.execute(sql`
      WITH validated AS MATERIALIZED (
        SELECT
          workflow_task.id AS task_id,
          workflow_task.execution_id
        FROM ${this.tasksTable} workflow_task
        INNER JOIN ${this.executionsTable} workflow_execution
          ON workflow_execution.id = workflow_task.execution_id
        WHERE workflow_task.id = ${request.taskId}::uuid
          AND workflow_task.reservation_token = ${request.reservationToken}::uuid
          AND workflow_task.kind = 'workflow'
          AND workflow_task.execution_id = ${request.executionId}
          AND workflow_execution.revision = ${request.expectedRevision}
          AND workflow_execution.parent_execution_id IS NULL
          AND (
            workflow_execution.concurrency_key IS NULL
            OR workflow_execution.concurrency_conflict IN ('reject', 'return-existing')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${this.executionsTable} child_execution
            WHERE child_execution.parent_execution_id = workflow_execution.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${this.executionsTable} pending_execution
            WHERE pending_execution.workflow_name = workflow_execution.workflow_name
              AND pending_execution.concurrency_key = workflow_execution.concurrency_key
              AND pending_execution.status = 'pending'
          )
        FOR UPDATE OF workflow_task, workflow_execution
      ),
      updated_execution AS (
        UPDATE ${this.executionsTable} AS workflow_execution
        SET
          status = ${outcome.status},
          output = ${sql.param(output, this.executionsTable.output)},
          output_present = ${hasOutput},
          error = ${sql.param(error, this.executionsTable.error)},
          concurrency_admitted = false,
          updated_at = statement_timestamp(),
          completed_at = statement_timestamp()
        FROM validated
        WHERE workflow_execution.id = validated.execution_id
        RETURNING workflow_execution.id
      ),
      deleted_tasks AS (
        DELETE FROM ${this.tasksTable} AS workflow_task
        USING updated_execution
        WHERE workflow_task.execution_id = updated_execution.id
        RETURNING workflow_task.id
      )
      SELECT EXISTS (SELECT 1 FROM deleted_tasks) AS committed
    `);

    return result.rows[0]?.committed === true;
  }

  public async completeActivities(
    requests: readonly CompleteWorkflowActivityRequest[],
  ): Promise<readonly WorkflowTaskReservationRef[]> {
    if (requests.length === 0) return [];
    const values = completionRequestValues(requests);
    const result = await this.database.execute(sql`
      WITH requested(
        request_order,
        task_id,
        reservation_token,
        execution_id,
        command_sequence,
        result,
        result_present,
        error
      ) AS (
        VALUES ${values}
      ),
      locked AS MATERIALIZED (
        SELECT
          requested.request_order,
          workflow_task.id AS task_id,
          workflow_task.reservation_token,
          workflow_task.execution_id,
          workflow_execution.revision,
          requested.command_sequence,
          requested.result,
          requested.result_present,
          requested.error,
          (
            SELECT count(*)::integer
            FROM ${this.historyTable} completed_history
            WHERE completed_history.execution_id = workflow_task.execution_id
              AND completed_history.type = 'command-completed'
          ) AS base_completion_order
        FROM requested
        INNER JOIN ${this.tasksTable} workflow_task
          ON workflow_task.id = requested.task_id
          AND workflow_task.reservation_token = requested.reservation_token
        INNER JOIN ${this.executionsTable} workflow_execution
          ON workflow_execution.id = workflow_task.execution_id
        WHERE workflow_task.kind IN ('activity', 'timer')
          AND workflow_task.execution_id = requested.execution_id
          AND workflow_task.command_sequence = requested.command_sequence
        ORDER BY workflow_task.execution_id, workflow_task.id
        FOR UPDATE OF workflow_task, workflow_execution
      ),
      validated AS (
        SELECT
          locked.*,
          row_number() OVER (
            PARTITION BY locked.execution_id
            ORDER BY locked.request_order
          )::integer - 1 AS completion_offset
        FROM locked
      ),
      completed_command AS (
        INSERT INTO ${this.historyTable} (
          execution_id,
          event_index,
          type,
          command_sequence,
          completion_order,
          payload,
          payload_present,
          error
        )
        SELECT
          validated.execution_id,
          validated.revision + validated.completion_offset,
          'command-completed',
          validated.command_sequence,
          validated.base_completion_order + validated.completion_offset,
          validated.result,
          validated.result_present,
          validated.error
        FROM validated
        RETURNING execution_id, event_index
      ),
      completed_executions AS (
        SELECT
          validated.execution_id,
          min(validated.revision)::integer AS base_revision,
          count(*)::integer AS completion_count
        FROM validated
        INNER JOIN completed_command
          ON completed_command.execution_id = validated.execution_id
          AND completed_command.event_index
            = validated.revision + validated.completion_offset
        GROUP BY validated.execution_id
      ),
      updated_execution AS (
        UPDATE ${this.executionsTable} AS workflow_execution
        SET
          status = 'queued',
          revision = completed_executions.base_revision
            + completed_executions.completion_count,
          updated_at = statement_timestamp()
        FROM completed_executions
        WHERE workflow_execution.id = completed_executions.execution_id
        RETURNING workflow_execution.id
      ),
      deleted_tasks AS (
        DELETE FROM ${this.tasksTable} AS workflow_task
        USING validated, updated_execution
        WHERE workflow_task.id = validated.task_id
          AND workflow_task.execution_id = updated_execution.id
        RETURNING
          workflow_task.id AS task_id,
          workflow_task.reservation_token,
          workflow_task.execution_id
      ),
      created_activation AS (
        INSERT INTO ${this.tasksTable} (execution_id, kind)
        SELECT DISTINCT deleted_tasks.execution_id, 'workflow'
        FROM deleted_tasks
        ON CONFLICT DO NOTHING
        RETURNING id
      )
      SELECT
        deleted_tasks.task_id,
        deleted_tasks.reservation_token,
        (SELECT count(*) FROM created_activation) AS created_activation_count
      FROM deleted_tasks
    `);

    return mapTaskReservations(result.rows);
  }

  public async retryTask(request: RetryWorkflowTaskRequest): Promise<boolean> {
    const [updated] = await this.database.update(this.tasksTable).set({
      availableAt: request.retryAt,
      reservedAt: null,
      reservationToken: null,
    }).where(and(
      eq(this.tasksTable.id, request.taskId),
      eq(this.tasksTable.reservationToken, request.reservationToken),
      eq(this.tasksTable.kind, "activity"),
    )).returning({ id: this.tasksTable.id });
    return updated !== undefined;
  }

  public async reserveActivityDispatches(
    request: ReserveWorkflowActivityDispatchesRequest,
  ): Promise<readonly ReservedWorkflowActivityDispatch[]> {
    validatePositiveInteger("activity dispatch limit", request.limit);
    validatePositiveInteger("activity dispatch leaseMs", request.leaseMs);
    const result = await this.database.execute(sql`
      WITH selected AS (
        SELECT dispatch.id
        FROM ${this.dispatchOutboxTable} dispatch
        INNER JOIN ${this.executionsTable} execution
          ON execution.id = dispatch.execution_id
        WHERE dispatch.published_at IS NULL
          AND dispatch.available_at <= statement_timestamp()
          AND execution.status NOT IN ('cancelled', 'completed', 'failed', 'terminated')
          AND execution.cancellation_requested = false
          AND execution.paused_at IS NULL
        ORDER BY dispatch.available_at, dispatch.id
        FOR UPDATE OF dispatch SKIP LOCKED
        LIMIT ${request.limit}
      )
      UPDATE ${this.dispatchOutboxTable} dispatch
      SET
        available_at = statement_timestamp()
          + (${request.leaseMs} * interval '1 millisecond'),
        reserved_at = statement_timestamp(),
        reservation_token = uuidv7(),
        attempt = dispatch.attempt + 1
      FROM selected
      WHERE dispatch.id = selected.id
      RETURNING
        dispatch.id,
        dispatch.execution_id,
        dispatch.command_sequence,
        dispatch.target,
        dispatch.payload,
        dispatch.attempt,
        dispatch.available_at,
        dispatch.reserved_at,
        dispatch.reservation_token,
        dispatch.created_at
    `);

    return (result.rows as unknown as ReservedDispatchRow[])
      .map(mapReservedDispatch);
  }

  public async markActivityDispatchesPublished(
    reservations: readonly WorkflowActivityDispatchReservationRef[],
  ): Promise<readonly WorkflowActivityDispatchReservationRef[]> {
    if (reservations.length === 0) return [];
    const values = dispatchReservationValues(reservations);
    const result = await this.database.execute(sql`
      WITH requested(dispatch_id, reservation_token) AS (
        VALUES ${values}
      )
      UPDATE ${this.dispatchOutboxTable} dispatch
      SET
        published_at = statement_timestamp(),
        reserved_at = NULL,
        reservation_token = NULL
      FROM requested
      WHERE dispatch.id = requested.dispatch_id
        AND dispatch.reservation_token = requested.reservation_token
      RETURNING
        dispatch.id AS dispatch_id,
        requested.reservation_token
    `);
    return mapDispatchReservations(result.rows);
  }

  public async retryActivityDispatches(
    requests: readonly RetryWorkflowActivityDispatchRequest[],
  ): Promise<readonly WorkflowActivityDispatchReservationRef[]> {
    if (requests.length === 0) return [];
    const values = sql.join(requests.map((request) => sql`(
      ${request.dispatchId}::uuid,
      ${request.reservationToken}::uuid,
      ${request.retryAt}::timestamptz
    )`), sql`, `);
    const result = await this.database.execute(sql`
      WITH requested(dispatch_id, reservation_token, retry_at) AS (
        VALUES ${values}
      )
      UPDATE ${this.dispatchOutboxTable} dispatch
      SET
        available_at = requested.retry_at,
        reserved_at = NULL,
        reservation_token = NULL
      FROM requested
      WHERE dispatch.id = requested.dispatch_id
        AND dispatch.reservation_token = requested.reservation_token
      RETURNING
        dispatch.id AS dispatch_id,
        requested.reservation_token
    `);
    return mapDispatchReservations(result.rows);
  }

  public async completeExternalActivity(
    request: CompleteExternalWorkflowActivityRequest,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [execution] = await transaction.select()
        .from(this.executionsTable)
        .where(eq(this.executionsTable.id, request.executionId))
        .for("update");
      if (execution === undefined) return false;

      const [existing] = await transaction.select({
        eventIndex: this.historyTable.eventIndex,
      }).from(this.historyTable).where(and(
        eq(this.historyTable.executionId, request.executionId),
        eq(this.historyTable.type, "command-completed"),
        eq(this.historyTable.commandSequence, request.sequence),
      )).limit(1);
      if (existing !== undefined) return true;
      if (isTerminalWorkflowStatus(execution.status)) return true;

      const [scheduled] = await transaction.select({
        eventIndex: this.historyTable.eventIndex,
      }).from(this.historyTable).where(and(
        eq(this.historyTable.executionId, request.executionId),
        eq(this.historyTable.type, "command-scheduled"),
        eq(this.historyTable.commandKind, "activity"),
        eq(this.historyTable.commandSequence, request.sequence),
      )).limit(1);
      if (scheduled === undefined) return false;

      const [{ count: completionOrder = 0 } = {}] = await transaction
        .select({ count: sql<number>`count(*)::integer` })
        .from(this.historyTable)
        .where(and(
          eq(this.historyTable.executionId, request.executionId),
          eq(this.historyTable.type, "command-completed"),
        ));
      await transaction.insert(this.historyTable).values({
        executionId: request.executionId,
        eventIndex: execution.revision,
        type: "command-completed",
        commandSequence: request.sequence,
        completionOrder,
        sourceId: request.sourceId,
        ...(request.status === "completed"
          ? request.result === undefined
            ? { payloadPresent: false }
            : { payload: request.result, payloadPresent: true }
          : { error: request.error, payloadPresent: false }),
      });
      await transaction.update(this.executionsTable).set({
        status: "queued",
        revision: execution.revision + 1,
        updatedAt: sql`statement_timestamp()`,
      }).where(eq(this.executionsTable.id, request.executionId));
      await transaction.insert(this.tasksTable).values({
        executionId: request.executionId,
        kind: "workflow",
      }).onConflictDoNothing();
      return true;
    });
  }

  public async requestCancellation(executionId: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      return this.cancelExecutionTree(
        transaction as PostgresWorkflowDatabase,
        executionId,
        true,
      );
    });
  }

  public async setPaused(executionId: string, paused: boolean): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [execution] = await transaction.select()
        .from(this.executionsTable)
        .where(eq(this.executionsTable.id, executionId))
        .for("update");
      if (execution === undefined) {
        throw new WorkflowExecutionNotFoundError(executionId);
      }
      if (isTerminalWorkflowStatus(execution.status)) return false;
      if ((execution.pausedAt !== null) === paused) return false;

      await transaction.update(this.executionsTable).set({
        pausedAt: paused ? sql`statement_timestamp()` : null,
        updatedAt: sql`statement_timestamp()`,
      }).where(eq(this.executionsTable.id, executionId));
      if (!paused && execution.concurrencyAdmitted) {
        await transaction.insert(this.tasksTable).values({
          executionId,
          kind: "workflow",
        }).onConflictDoNothing();
      }
      return true;
    });
  }

  public async forceTerminate(
    executionId: string,
    reason = "Terminated by an operator.",
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const changed = await this.terminateExecutionTree(
        transaction as PostgresWorkflowDatabase,
        executionId,
        reason,
        true,
      );
      return changed;
    });
  }

  public async retryExecution(
    request: RetryWorkflowExecutionRequest,
  ): Promise<StartWorkflowExecutionResult> {
    validateExecutionId(request.executionId);
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`workflow-retry:${request.executionId}`}, 0)
        )
      `);
      const [source] = await transaction.select()
        .from(this.executionsTable)
        .where(eq(this.executionsTable.id, request.sourceExecutionId))
        .for("update");
      if (source === undefined) {
        throw new WorkflowExecutionNotFoundError(request.sourceExecutionId);
      }
      if (source.status !== "failed") {
        throw new TypeError("Only failed workflow executions can be retried.");
      }
      const [existing] = await transaction.select()
        .from(this.executionsTable)
        .where(eq(this.executionsTable.id, request.executionId))
        .for("update");
      if (existing !== undefined) {
        if (existing.retryOfExecutionId !== source.id) {
          throw new WorkflowExecutionConflictError(request.executionId);
        }
        return { execution: mapExecution(existing), created: false };
      }

      let concurrencyAdmitted = true;
      if (source.concurrencyScope === "execution"
        && source.concurrencyKey !== null
        && source.concurrencyKeyLimit !== null) {
        await transaction.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`workflow-key:${source.workflowName}:${source.concurrencyKey}`},
              0
            )
          )
        `);
        const [{ count = 0 } = {}] = await transaction.select({
          count: sql<number>`count(*)::integer`,
        }).from(this.executionsTable).where(and(
          eq(this.executionsTable.workflowName, source.workflowName),
          eq(this.executionsTable.concurrencyKey, source.concurrencyKey),
          eq(this.executionsTable.concurrencyAdmitted, true),
          sql`${this.executionsTable.status} NOT IN ('cancelled', 'completed', 'failed', 'terminated')`,
        ));
        concurrencyAdmitted = count < source.concurrencyKeyLimit;
      }

      const originalInput = source.initialInput?.value ?? source.input ?? null;
      const [created] = await transaction.insert(this.executionsTable).values({
        id: request.executionId,
        workflowName: source.workflowName,
        workflowVersion: request.workflowVersion,
        historyGeneration: 1,
        input: originalInput,
        initialInput: { value: originalInput },
        status: concurrencyAdmitted ? "queued" : "pending",
        rootExecutionId: request.executionId,
        retryOfExecutionId: source.id,
        concurrencyAdmitted,
        definitionConcurrencyLimit: source.definitionConcurrencyLimit,
        concurrencyKey: source.concurrencyKey,
        concurrencyKeyLimit: source.concurrencyKeyLimit,
        concurrencyConflict: source.concurrencyConflict,
        concurrencyScope: source.concurrencyScope,
      }).returning();
      if (created === undefined) {
        throw new Error("PostgreSQL did not return the retried workflow execution.");
      }
      if (concurrencyAdmitted) {
        await transaction.insert(this.tasksTable).values({
          executionId: created.id,
          kind: "workflow",
        }).onConflictDoNothing();
      }
      return { execution: mapExecution(created), created: true };
    });
  }

  public async releaseTasks(
    reservations: readonly WorkflowTaskReservationRef[],
  ): Promise<readonly WorkflowTaskReservationRef[]> {
    return this.mutateReservations(reservations, async (transaction, task) => {
      await transaction.update(this.tasksTable).set({
        availableAt: sql`statement_timestamp()`,
        reservedAt: null,
        reservationToken: null,
      }).where(eq(this.tasksTable.id, task.id));

      if (task.kind === "workflow") {
        await transaction.update(this.executionsTable).set({
          status: "queued",
          updatedAt: sql`statement_timestamp()`,
        }).where(eq(this.executionsTable.id, task.executionId));
      }
    });
  }

  public async extendTaskLeases(
    reservations: readonly ExtendWorkflowTaskLeaseRequest[],
  ): Promise<readonly WorkflowTaskReservationRef[]> {
    for (const reservation of reservations) {
      if (!Number.isSafeInteger(reservation.leaseMs) || reservation.leaseMs < 1) {
        throw new TypeError("Workflow task leaseMs must be a positive integer.");
      }
    }

    return this.mutateReservations(reservations, async (transaction, task, request) => {
      await transaction.update(this.tasksTable).set({
        availableAt: sql`statement_timestamp()
          + (${request.leaseMs} * interval '1 millisecond')`,
      }).where(eq(this.tasksTable.id, task.id));
    });
  }

  public async getHistory(
    executionId: string,
  ): Promise<readonly WorkflowHistoryEvent[]> {
    const execution = await this.get(executionId);

    if (execution === undefined) {
      throw new WorkflowExecutionNotFoundError(executionId);
    }

    const rows = await this.database.select()
      .from(this.historyTable)
      .where(eq(this.historyTable.executionId, executionId))
      .orderBy(asc(this.historyTable.eventIndex));
    return rows.map(mapHistoryEvent);
  }

  public async summarizeExecutionVersions(): Promise<
    readonly WorkflowExecutionVersionSummary[]
  > {
    return this.database.select({
      workflowName: this.executionsTable.workflowName,
      workflowVersion: this.executionsTable.workflowVersion,
      status: this.executionsTable.status,
      count: sql<number>`count(*)::integer`,
    }).from(this.executionsTable)
      .groupBy(
        this.executionsTable.workflowName,
        this.executionsTable.workflowVersion,
        this.executionsTable.status,
      )
      .orderBy(
        asc(this.executionsTable.workflowName),
        asc(this.executionsTable.workflowVersion),
        asc(this.executionsTable.status),
      );
  }

  public async recoverVersionBlockedExecution(
    request: RecoverVersionBlockedExecutionRequest,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [execution] = await transaction.select()
        .from(this.executionsTable)
        .where(eq(this.executionsTable.id, request.executionId))
        .for("update");
      if (
        execution === undefined
        || execution.workflowName !== request.workflowName
        || execution.workflowVersion !== request.workflowVersion
        || execution.status !== "blocked"
        || execution.error?.name !== "WorkflowExecutionVersionUnsupportedError"
      ) {
        return false;
      }

      await transaction.update(this.executionsTable).set({
        status: "queued",
        error: null,
        updatedAt: sql`statement_timestamp()`,
      }).where(eq(this.executionsTable.id, request.executionId));
      await transaction.insert(this.tasksTable).values({
        executionId: request.executionId,
        kind: "workflow",
      }).onConflictDoNothing();
      return true;
    });
  }

  public async continueAsNew(
    request: ContinueWorkflowAsNewRequest,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [task] = await transaction.select()
        .from(this.tasksTable)
        .where(and(
          eq(this.tasksTable.id, request.taskId),
          eq(this.tasksTable.reservationToken, request.reservationToken),
        ))
        .for("update");
      if (
        task === undefined
        || task.kind !== "workflow"
        || task.executionId !== request.executionId
      ) {
        return false;
      }
      const [execution] = await transaction.select()
        .from(this.executionsTable)
        .where(eq(this.executionsTable.id, request.executionId))
        .for("update");
      if (execution === undefined) return false;
      if (execution.revision !== request.expectedRevision) {
        throw new WorkflowJournalConflictError(
          request.executionId,
          request.expectedRevision,
          execution.revision,
        );
      }

      const rows = await transaction.select()
        .from(this.historyTable)
        .where(eq(this.historyTable.executionId, request.executionId))
        .orderBy(asc(this.historyTable.eventIndex));
      const history = rows.map(mapHistoryEvent);
      assertCommandsSettledBeforeContinuation(request.executionId, history);
      await transaction.insert(this.historyArchivesTable).values({
        executionId: request.executionId,
        historyGeneration: execution.historyGeneration,
        workflowVersion: execution.workflowVersion,
        input: execution.input ?? null,
        history: history.map((event) => ({
          ...event,
          occurredAt: event.occurredAt.toISOString(),
        })),
      });
      await transaction.delete(this.tasksTable).where(
        eq(this.tasksTable.executionId, request.executionId),
      );
      await transaction.delete(this.signalsTable).where(
        eq(this.signalsTable.executionId, request.executionId),
      );
      await transaction.delete(this.dispatchOutboxTable).where(
        eq(this.dispatchOutboxTable.executionId, request.executionId),
      );
      await transaction.delete(this.historyTable).where(
        eq(this.historyTable.executionId, request.executionId),
      );
      await transaction.update(this.executionsTable).set({
        workflowVersion: request.workflowVersion,
        historyGeneration: execution.historyGeneration + 1,
        input: request.input,
        revision: 0,
        status: "queued",
        output: null,
        outputPresent: false,
        error: null,
        cancellationRequested: false,
        completedAt: null,
        updatedAt: sql`statement_timestamp()`,
      }).where(eq(this.executionsTable.id, request.executionId));
      await transaction.insert(this.tasksTable).values({
        executionId: request.executionId,
        kind: "workflow",
      }).onConflictDoNothing();
      return true;
    });
  }

  public async getHistoryArchives(
    executionId: string,
  ): Promise<readonly WorkflowHistoryArchive[]> {
    const execution = await this.get(executionId);
    if (execution === undefined) {
      throw new WorkflowExecutionNotFoundError(executionId);
    }
    const rows = await this.database.select()
      .from(this.historyArchivesTable)
      .where(eq(this.historyArchivesTable.executionId, executionId))
      .orderBy(asc(this.historyArchivesTable.historyGeneration));
    return rows.map((row) => ({
      executionId: row.executionId,
      historyGeneration: row.historyGeneration,
      workflowVersion: row.workflowVersion,
      input: row.input ?? null,
      history: (row.history as Array<WorkflowHistoryEvent & { occurredAt: string }>)
        .map((event) => ({ ...event, occurredAt: new Date(event.occurredAt) })),
      continuedAt: row.continuedAt,
    }));
  }

  private async mutateReservations<
    Request extends WorkflowTaskReservationRef,
  >(
    reservations: readonly Request[],
    mutate: (
      transaction: PostgresWorkflowDatabase,
      task: typeof workflowTasks.$inferSelect,
      request: Request,
    ) => Promise<void>,
  ): Promise<readonly WorkflowTaskReservationRef[]> {
    if (reservations.length === 0) {
      return [];
    }

    return this.database.transaction(async (transaction) => {
      const changed: WorkflowTaskReservationRef[] = [];

      for (const reservation of reservations) {
        const [task] = await transaction.select()
          .from(this.tasksTable)
          .where(and(
            eq(this.tasksTable.id, reservation.taskId),
            eq(this.tasksTable.reservationToken, reservation.reservationToken),
          ))
          .for("update");

        if (task === undefined) {
          continue;
        }

        await mutate(
          transaction as PostgresWorkflowDatabase,
          task,
          reservation,
        );
        changed.push({
          taskId: reservation.taskId,
          reservationToken: reservation.reservationToken,
        });
      }

      return changed;
    });
  }

  /** Immediately closes one execution tree without replaying compensation code. */
  private async terminateExecutionTree(
    transaction: PostgresWorkflowDatabase,
    rootExecutionId: string,
    reason: string,
    requireRoot = false,
  ): Promise<boolean> {
    const pending = [rootExecutionId];
    const visited = new Set<string>();
    let root: typeof workflowExecutions.$inferSelect | undefined;
    let rootChanged = false;

    while (pending.length > 0) {
      const currentId = pending.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const [execution] = await transaction.select()
        .from(this.executionsTable)
        .where(eq(this.executionsTable.id, currentId))
        .for("update");
      if (execution === undefined) {
        if (requireRoot && currentId === rootExecutionId) {
          throw new WorkflowExecutionNotFoundError(rootExecutionId);
        }
        continue;
      }
      if (currentId === rootExecutionId) root = execution;
      const children = await transaction.select({ id: this.executionsTable.id })
        .from(this.executionsTable)
        .where(eq(this.executionsTable.parentExecutionId, currentId));
      pending.push(...children.map((child) => child.id));
      if (isTerminalWorkflowStatus(execution.status)) continue;

      await transaction.update(this.executionsTable).set({
        status: "terminated",
        error: { name: "WorkflowExecutionTerminatedError", message: reason },
        pausedAt: null,
        concurrencyAdmitted: false,
        completedAt: sql`statement_timestamp()`,
        updatedAt: sql`statement_timestamp()`,
      }).where(eq(this.executionsTable.id, currentId));
      await transaction.delete(this.tasksTable).where(
        eq(this.tasksTable.executionId, currentId),
      );
      await transaction.delete(this.dispatchOutboxTable).where(
        eq(this.dispatchOutboxTable.executionId, currentId),
      );
      await this.admitPendingKeyedExecutions(transaction, execution);
      if (currentId === rootExecutionId) rootChanged = true;
    }

    if (rootChanged && root !== undefined && root.parentExecutionId !== null
      && root.parentCommandSequence !== null) {
      const [parent] = await transaction.select()
        .from(this.executionsTable)
        .where(eq(this.executionsTable.id, root.parentExecutionId))
        .for("update");
      if (parent !== undefined && !isTerminalWorkflowStatus(parent.status)) {
        const [{ count = 0 } = {}] = await transaction.select({
          count: sql<number>`count(*)::integer`,
        }).from(this.historyTable).where(and(
          eq(this.historyTable.executionId, parent.id),
          eq(this.historyTable.type, "command-completed"),
        ));
        const [completion] = await transaction.insert(this.historyTable).values({
          executionId: parent.id,
          eventIndex: parent.revision,
          type: "command-completed",
          commandSequence: root.parentCommandSequence,
          completionOrder: count,
          error: {
            name: "WorkflowExecutionTerminatedError",
            message: `Child workflow "${root.id}" was terminated: ${reason}`,
            details: { executionId: root.id },
          },
        }).onConflictDoNothing().returning({
          eventIndex: this.historyTable.eventIndex,
        });
        if (completion !== undefined) {
          await transaction.update(this.executionsTable).set({
            revision: parent.revision + 1,
            status: "queued",
            updatedAt: sql`statement_timestamp()`,
          }).where(eq(this.executionsTable.id, parent.id));
          await transaction.insert(this.tasksTable).values({
            executionId: parent.id,
            kind: "workflow",
          }).onConflictDoNothing();
        }
      }
    }

    return rootChanged;
  }

  /** Marks one execution and all open descendants for cooperative cancellation. */
  private async cancelExecutionTree(
    transaction: PostgresWorkflowDatabase,
    rootExecutionId: string,
    requireRoot = false,
  ): Promise<boolean> {
    const pending = [rootExecutionId];
    const visited = new Set<string>();
    let rootChanged = false;

    while (pending.length > 0) {
      const currentId = pending.shift()!;

      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const [execution] = await transaction.select()
        .from(this.executionsTable)
        .where(eq(this.executionsTable.id, currentId))
        .for("update");

      if (execution === undefined) {
        if (requireRoot && currentId === rootExecutionId) {
          throw new WorkflowExecutionNotFoundError(rootExecutionId);
        }
        continue;
      }

      const children = await transaction.select({ id: this.executionsTable.id })
        .from(this.executionsTable)
        .where(eq(this.executionsTable.parentExecutionId, currentId));
      pending.push(...children.map((child) => child.id));

      if (isTerminalWorkflowStatus(execution.status)
        || execution.cancellationRequested) {
        continue;
      }

      await transaction.insert(this.historyTable).values({
        executionId: currentId,
        eventIndex: execution.revision,
        type: "cancellation-requested",
      });
      const pendingCancellation = execution.status === "pending";
      await transaction.update(this.executionsTable).set({
        cancellationRequested: true,
        pausedAt: null,
        status: pendingCancellation ? "cancelled" : "queued",
        revision: execution.revision + 1,
        ...(pendingCancellation
          ? {
              completedAt: sql`statement_timestamp()`,
              concurrencyAdmitted: false,
            }
          : {}),
        updatedAt: sql`statement_timestamp()`,
      }).where(eq(this.executionsTable.id, currentId));
      await transaction.delete(this.tasksTable).where(and(
        eq(this.tasksTable.executionId, currentId),
        sql`${this.tasksTable.kind} <> 'workflow'`,
      ));
      if (!pendingCancellation) {
        await transaction.insert(this.tasksTable).values({
          executionId: currentId,
          kind: "workflow",
        }).onConflictDoNothing();
      } else {
        await this.admitPendingKeyedExecutions(
          transaction,
          execution,
        );
      }

      if (currentId === rootExecutionId) rootChanged = true;
    }

    return rootChanged;
  }

  /** Admits the oldest pending executions after a retained permit is released. */
  private async admitPendingKeyedExecutions(
    transaction: PostgresWorkflowDatabase,
    released: typeof workflowExecutions.$inferSelect,
  ): Promise<void> {
    if (
      released.concurrencyScope !== "execution"
      || released.concurrencyKey === null
      || released.concurrencyKeyLimit === null
    ) return;

    await transaction.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${`workflow-key:${released.workflowName}:${released.concurrencyKey}`},
          0
        )
      )
    `);
    const [{ count: admitted = 0 } = {}] = await transaction.select({
      count: sql<number>`count(*)::integer`,
    }).from(this.executionsTable).where(and(
      eq(this.executionsTable.workflowName, released.workflowName),
      eq(this.executionsTable.concurrencyKey, released.concurrencyKey),
      eq(this.executionsTable.concurrencyAdmitted, true),
      sql`${this.executionsTable.status} NOT IN ('cancelled', 'completed', 'failed', 'terminated')`,
    ));
    const available = Math.max(0, released.concurrencyKeyLimit - admitted);

    if (available === 0) return;
    const waiting = await transaction.select()
      .from(this.executionsTable)
      .where(and(
        eq(this.executionsTable.workflowName, released.workflowName),
        eq(this.executionsTable.concurrencyKey, released.concurrencyKey),
        eq(this.executionsTable.status, "pending"),
      ))
      .orderBy(
        asc(this.executionsTable.createdAt),
        asc(this.executionsTable.id),
      )
      .limit(available)
      .for("update", { skipLocked: true });

    for (const execution of waiting) {
      await transaction.update(this.executionsTable).set({
        concurrencyAdmitted: true,
        status: "queued",
        updatedAt: sql`statement_timestamp()`,
      }).where(eq(this.executionsTable.id, execution.id));
      await transaction.insert(this.tasksTable).values({
        executionId: execution.id,
        kind: "workflow",
      }).onConflictDoNothing();
    }
  }
}

function normalizeStartBatch(
  requests: readonly StartWorkflowExecutionRequest[],
): NormalizedStartBatch {
  const uniqueRequests: StartWorkflowExecutionRequest[] = [];
  const firstIndexByExecutionId = new Map<string, number>();
  const originals: NormalizedStartBatch["originals"][number][] = [];

  for (const request of requests) {
    validateExecutionId(request.executionId);
    const uniqueIndex = firstIndexByExecutionId.get(request.executionId);

    if (uniqueIndex === undefined) {
      firstIndexByExecutionId.set(request.executionId, uniqueRequests.length);
      originals.push({
        uniqueIndex: uniqueRequests.length,
        firstOccurrence: true,
      });
      uniqueRequests.push(request);
      continue;
    }

    const first = uniqueRequests[uniqueIndex]!;
    if (
      first.workflowName !== request.workflowName
      || !isDeepStrictEqual(first.input, request.input)
    ) {
      throw new WorkflowExecutionConflictError(request.executionId);
    }
    originals.push({ uniqueIndex, firstOccurrence: false });
  }

  return { uniqueRequests, originals };
}

function validateStartConcurrencyGroups(
  requests: readonly StartWorkflowExecutionRequest[],
): void {
  const groups = new Map<string, NonNullable<
    NonNullable<StartWorkflowExecutionRequest["concurrency"]>["keyed"]
  >>();

  for (const request of requests) {
    const keyed = request.concurrency?.keyed;
    if (keyed === undefined) continue;
    const group = `${request.workflowName}\0${keyed.key}`;
    const existing = groups.get(group);

    if (existing !== undefined && (
      existing.limit !== keyed.limit
      || existing.conflict !== keyed.conflict
      || existing.scope !== keyed.scope
    )) {
      throw new TypeError(
        `Workflow start batch uses inconsistent concurrency for "${request.workflowName}:${keyed.key}".`,
      );
    }
    groups.set(group, keyed);
  }
}

function getStartLockKeys(
  requests: readonly StartWorkflowExecutionRequest[],
): readonly string[] {
  const keys = new Set<string>();

  for (const request of requests) {
    keys.add(`workflow-start:${request.executionId}`);
    const keyed = request.concurrency?.keyed;
    if (keyed !== undefined) {
      keys.add(`workflow-key:${request.workflowName}:${keyed.key}`);
    }
  }

  return [...keys].sort();
}

function startRequestValues(
  requests: readonly StartWorkflowExecutionRequest[],
) {
  return sql.join(requests.map((request, requestOrder) => {
    const keyed = request.concurrency?.keyed;
    return sql`(
      ${requestOrder}::integer,
      ${request.executionId}::text,
      ${request.workflowName}::text,
      ${request.workflowVersion}::integer,
      ${JSON.stringify(request.input)}::jsonb,
      ${request.rootExecutionId ?? request.executionId}::text,
      ${request.parentExecutionId ?? null}::text,
      ${request.parentCommandSequence ?? null}::integer,
      ${request.concurrency?.definitionLimit ?? null}::integer,
      ${keyed?.key ?? null}::text,
      ${keyed?.limit ?? null}::integer,
      ${keyed?.conflict ?? null}::text,
      ${keyed?.scope ?? null}::text
    )`;
  }), sql`, `);
}

function mapSerializedExecution(
  row: SerializedWorkflowExecution,
): WorkflowExecution {
  return {
    executionId: row.id,
    workflowName: row.workflow_name,
    workflowVersion: row.workflow_version,
    historyGeneration: row.history_generation,
    input: row.input ?? null,
    status: row.status,
    cancellationRequested: row.cancellation_requested,
    ...(row.paused_at === null ? {} : { pausedAt: new Date(row.paused_at) }),
    rootExecutionId: row.root_execution_id,
    ...(row.retry_of_execution_id === null
      ? {}
      : { retryOfExecutionId: row.retry_of_execution_id }),
    concurrencyAdmitted: row.concurrency_admitted,
    ...(row.definition_concurrency_limit === null && row.concurrency_key === null
      ? {}
      : {
          concurrency: {
            ...(row.definition_concurrency_limit === null
              ? {}
              : { definitionLimit: row.definition_concurrency_limit }),
            ...(row.concurrency_key === null
              || row.concurrency_key_limit === null
              || row.concurrency_conflict === null
              || row.concurrency_scope === null
              ? {}
              : {
                  keyed: {
                    key: row.concurrency_key,
                    limit: row.concurrency_key_limit,
                    conflict: row.concurrency_conflict,
                    scope: row.concurrency_scope,
                  },
                }),
          },
        }),
    ...(row.parent_execution_id === null
      ? {}
      : { parentExecutionId: row.parent_execution_id }),
    ...(row.parent_command_sequence === null
      ? {}
      : { parentCommandSequence: row.parent_command_sequence }),
    ...(row.output_present ? { output: row.output ?? null } : {}),
    ...(row.error === null ? {} : { error: row.error }),
    revision: row.revision,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    ...(row.completed_at === null
      ? {}
      : { completedAt: new Date(row.completed_at) }),
  };
}

function mapExecution(
  row: typeof workflowExecutions.$inferSelect,
): WorkflowExecution {
  return {
    executionId: row.id,
    workflowName: row.workflowName,
    workflowVersion: row.workflowVersion,
    historyGeneration: row.historyGeneration,
    input: row.input ?? null,
    status: row.status,
    cancellationRequested: row.cancellationRequested,
    ...(row.pausedAt === null ? {} : { pausedAt: row.pausedAt }),
    rootExecutionId: row.rootExecutionId,
    ...(row.retryOfExecutionId === null
      ? {}
      : { retryOfExecutionId: row.retryOfExecutionId }),
    concurrencyAdmitted: row.concurrencyAdmitted,
    ...(row.definitionConcurrencyLimit === null && row.concurrencyKey === null
      ? {}
      : {
          concurrency: {
            ...(row.definitionConcurrencyLimit === null
              ? {}
              : { definitionLimit: row.definitionConcurrencyLimit }),
            ...(row.concurrencyKey === null
              || row.concurrencyKeyLimit === null
              || row.concurrencyConflict === null
              || row.concurrencyScope === null
              ? {}
              : {
                  keyed: {
                    key: row.concurrencyKey,
                    limit: row.concurrencyKeyLimit,
                    conflict: row.concurrencyConflict,
                    scope: row.concurrencyScope,
                  },
                }),
          },
        }),
    ...(row.parentExecutionId === null
      ? {}
      : { parentExecutionId: row.parentExecutionId }),
    ...(row.parentCommandSequence === null
      ? {}
      : { parentCommandSequence: row.parentCommandSequence }),
    ...(row.outputPresent ? { output: row.output ?? null } : {}),
    ...(row.error === null ? {} : { error: row.error }),
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
  };
}

function validateExecutionQuery(query: WorkflowExecutionQuery): void {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200) {
    throw new TypeError("Workflow execution query limit must be between 1 and 200.");
  }
}

function assertCommandsSettledBeforeContinuation(
  executionId: string,
  history: readonly WorkflowHistoryEvent[],
): void {
  const completed = new Set(history
    .filter((event) => event.type === "command-completed")
    .map((event) => event.sequence));
  const pending = history.find((event) =>
    event.type === "command-scheduled" && !completed.has(event.sequence));
  if (pending !== undefined && pending.type === "command-scheduled") {
    throw new TypeError(
      `Workflow execution "${executionId}" cannot continue as new with pending command ${pending.sequence}.`,
    );
  }
}

function mapReservedTask(row: ReservedTaskRow): ReservedWorkflowTask {
  return {
    id: row.id,
    executionId: row.execution_id,
    workflowName: row.workflow_name,
    workflowVersion: row.workflow_version,
    historyGeneration: row.history_generation,
    rootExecutionId: row.root_execution_id,
    ...(row.parent_execution_id === null
      ? {}
      : { parentExecutionId: row.parent_execution_id }),
    kind: row.kind,
    ...(row.command_sequence === null
      ? {}
      : { commandSequence: row.command_sequence }),
    ...(row.target === null ? {} : { target: row.target }),
    ...(row.kind === "activity" || row.kind === "timer"
      ? { payload: row.payload ?? null }
      : {}),
    attempt: row.attempt,
    availableAt: row.available_at,
    reservedAt: row.reserved_at,
    reservationToken: row.reservation_token,
    createdAt: row.created_at,
  };
}

function mapReservedDispatch(
  row: ReservedDispatchRow,
): ReservedWorkflowActivityDispatch {
  return {
    id: row.id,
    executionId: row.execution_id,
    sequence: row.command_sequence,
    target: row.target,
    payload: row.payload ?? null,
    attempt: row.attempt,
    availableAt: row.available_at,
    reservedAt: row.reserved_at,
    reservationToken: row.reservation_token,
    createdAt: row.created_at,
  };
}

function dispatchReservationValues(
  reservations: readonly WorkflowActivityDispatchReservationRef[],
) {
  return sql.join(reservations.map((reservation) => sql`(
    ${reservation.dispatchId}::uuid,
    ${reservation.reservationToken}::uuid
  )`), sql`, `);
}

function mapDispatchReservations(
  rows: readonly unknown[],
): readonly WorkflowActivityDispatchReservationRef[] {
  return (rows as Array<{
    dispatch_id: string;
    reservation_token: string;
  }>).map((row) => ({
    dispatchId: row.dispatch_id,
    reservationToken: row.reservation_token,
  }));
}

function completionRequestValues(
  requests: readonly CompleteWorkflowActivityRequest[],
) {
  return sql.join(requests.map((request, requestOrder) => {
    const completed = request.status === "completed";
    const resultPresent = completed && request.result !== undefined;
    const result = resultPresent ? request.result : null;
    const error = request.status === "failed" ? request.error : null;

    return sql`(
      ${requestOrder}::integer,
      ${request.taskId}::uuid,
      ${request.reservationToken}::uuid,
      ${request.executionId}::text,
      ${request.sequence}::integer,
      ${JSON.stringify(result)}::jsonb,
      ${resultPresent}::boolean,
      ${JSON.stringify(error)}::jsonb
    )`;
  }), sql`, `);
}

function mapTaskReservations(
  rows: readonly unknown[],
): readonly WorkflowTaskReservationRef[] {
  return (rows as Array<{
    task_id: string;
    reservation_token: string;
  }>).map((row) => ({
    taskId: row.task_id,
    reservationToken: row.reservation_token,
  }));
}

function mapHistoryEvent(
  row: typeof workflowHistoryEvents.$inferSelect,
): WorkflowHistoryEvent {
  if (
    row.type === "command-scheduled"
    && row.commandSequence !== null
    && row.commandKind !== null
    && row.target !== null
  ) {
    return {
      type: row.type,
      eventIndex: row.eventIndex,
      sequence: row.commandSequence,
      kind: row.commandKind,
      target: row.target,
      payload: row.payload ?? null,
      occurredAt: row.occurredAt,
    };
  }

  if (
    row.type === "command-completed"
    && row.commandSequence !== null
    && row.completionOrder !== null
  ) {
    return {
      type: row.type,
      eventIndex: row.eventIndex,
      sequence: row.commandSequence,
      completionOrder: row.completionOrder,
      ...(row.payloadPresent ? { result: row.payload ?? null } : {}),
      ...(row.error === null ? {} : { error: row.error }),
      ...(row.sourceId === null ? {} : { sourceId: row.sourceId }),
      occurredAt: row.occurredAt,
    };
  }

  if (
    row.type === "signal-received"
    && row.signalId !== null
    && row.signalName !== null
  ) {
    return {
      type: row.type,
      eventIndex: row.eventIndex,
      signalId: row.signalId,
      name: row.signalName,
      payload: row.payload ?? null,
      occurredAt: row.occurredAt,
    };
  }

  if (row.type === "cancellation-requested") {
    return {
      type: row.type,
      eventIndex: row.eventIndex,
      occurredAt: row.occurredAt,
    };
  }

  throw new Error(
    `Invalid workflow history event ${row.eventIndex} for execution "${row.executionId}".`,
  );
}

/** Restores Drizzle's typed row shape after PostgreSQL JSON aggregation. */
function mapSerializedHistoryEvent(row: SerializedHistoryRow): WorkflowHistoryEvent {
  return mapHistoryEvent({
    executionId: row.execution_id,
    eventIndex: row.event_index,
    type: row.type,
    commandSequence: row.command_sequence,
    completionOrder: row.completion_order,
    commandKind: row.command_kind,
    target: row.target,
    signalId: row.signal_id,
    signalName: row.signal_name,
    payload: row.payload,
    payloadPresent: row.payload_present,
    error: row.error,
    sourceId: row.source_id,
    occurredAt: new Date(row.occurred_at),
  });
}

function validateExecutionId(executionId: string): void {
  if (executionId.length === 0) {
    throw new TypeError("Workflow execution IDs cannot be empty.");
  }
}

function validateReservationRequest(request: ReserveWorkflowTasksRequest): void {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
    throw new TypeError("Workflow task reservation limit must be positive.");
  }

  if (!Number.isSafeInteger(request.leaseMs) || request.leaseMs < 1) {
    throw new TypeError("Workflow task leaseMs must be positive.");
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Workflow ${name} must be positive.`);
  }
}

function readRecord(payload: WorkflowPayload): Readonly<Record<string, WorkflowPayload>> {
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    throw new TypeError("Workflow command payload must be an object.");
  }

  return payload as Readonly<Record<string, WorkflowPayload>>;
}

function readNumber(payload: WorkflowPayload, key: string): number {
  const value = readRecord(payload)[key];

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Workflow command field "${key}" must be non-negative.`);
  }

  return value;
}

function readOptionalNumber(
  payload: WorkflowPayload,
  key: string,
): number | undefined {
  return readRecord(payload)[key] === undefined
    ? undefined
    : readNumber(payload, key);
}

function readOptionalString(
  payload: WorkflowPayload,
  key: string,
): string | undefined {
  const value = readRecord(payload)[key];

  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Workflow command field "${key}" must be non-empty.`);
  }
  return value;
}

function readPayload(payload: WorkflowPayload, key: string): WorkflowPayload {
  const value = readRecord(payload)[key];

  if (value === undefined) {
    throw new TypeError(`Workflow command field "${key}" is required.`);
  }
  return value;
}

function readOptionalConcurrency(
  payload: WorkflowPayload,
): ResolvedWorkflowConcurrency | undefined {
  const value = readRecord(payload).concurrency;

  if (value === undefined) return undefined;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Workflow child concurrency must be an object.");
  }

  const record = value as Readonly<Record<string, WorkflowPayload>>;
  const definitionLimit = record.definitionLimit;
  const keyedValue = record.keyed;

  if (definitionLimit !== undefined
    && (typeof definitionLimit !== "number"
      || !Number.isSafeInteger(definitionLimit)
      || definitionLimit < 1)) {
    throw new TypeError("Workflow definition concurrency limit is invalid.");
  }

  return {
    ...(definitionLimit === undefined ? {} : { definitionLimit }),
    ...(keyedValue === undefined
      ? {}
      : { keyed: readResolvedKeyedConcurrency(keyedValue) }),
  };
}

function readResolvedKeyedConcurrency(
  value: WorkflowPayload,
): NonNullable<ResolvedWorkflowConcurrency["keyed"]> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Workflow keyed concurrency must be an object.");
  }

  const record = value as Readonly<Record<string, WorkflowPayload>>;
  const { key, limit, scope } = record;

  if (typeof key !== "string" || key.length === 0
    || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1
    || (scope !== "execution" && scope !== "active-work")) {
    throw new TypeError("Workflow keyed concurrency metadata is invalid.");
  }

  return { key, limit, conflict: "enqueue", scope };
}
