import {
  and,
  eq,
  inArray,
  lte,
  sql,
} from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { uuidV7 } from "../../../utils/uuid.js";

import {
  workerDeadLetterJobs,
  workerJobs,
  workerQueueControls,
} from "./schema.js";
import { WorkerJobIdentityConflictError } from "../../errors.js";
import type {
  DeadLetterJobRequest,
  DeferJobRequest,
  EnqueueJobRequest,
  ExtendJobLeaseRequest,
  JobReservationRef,
  ReservedJob,
  ReserveJobsRequest,
  RetryJobRequest,
  WorkerAdapter,
  WorkerQueueStatistics,
} from "../../types.js";

export type PostgresWorkerDatabase = PgDatabase<
  NodePgQueryResultHKT,
  Record<string, unknown>
>;

interface ReservationRow {
  id: string;
  identity: string | null;
  queue: string;
  payload: unknown;
  correlation: import("../../types.js").WorkerJobCorrelation | null;
  group_id: string | null;
  execution_id: string | null;
  attempt: number;
  available_at: Date;
  reserved_at: Date;
  reservation_token: string;
  created_at: Date;
}

interface ReservationReferenceRow {
  job_id: string;
  reservation_token: string;
}

interface QueueStatisticsRow {
  queue: string;
  enabled: boolean;
  ready: number;
  scheduled: number;
  reserved: number;
}

// Keep multi-row inserts below PostgreSQL's parameter bound, even for large
// publications. Multiple chunks remain atomic inside one transaction.
const enqueueChunkSize = 1_000;

/** PostgreSQL adapter using short atomic statements and server-side time. */
export class PostgresWorkerAdapter implements WorkerAdapter {
  public readonly acknowledgementGrouping = "global" as const;

  public constructor(
    private readonly database: PostgresWorkerDatabase,
    private readonly jobsTable: typeof workerJobs = workerJobs,
    private readonly deadLetterTable: typeof workerDeadLetterJobs = workerDeadLetterJobs,
    private readonly queueControlsTable: typeof workerQueueControls = workerQueueControls,
  ) {}

  public async enqueue<Payload>(
    requests: readonly EnqueueJobRequest<Payload>[],
  ): Promise<readonly string[]> {
    if (requests.length === 0) {
      return [];
    }

    const identities = [...new Set(requests.flatMap((request) =>
      request.identity === undefined ? [] : [request.identity]))];
    const publish = async (database: PostgresWorkerDatabase) => {
      const existingByIdentity = new Map<string, IdentityJob>();

      if (identities.length > 0) {
        // Order actual lock keys (including hash collisions) consistently.
        // The following read needs a fresh snapshot after contending writers
        // commit, so it must remain separate from lock acquisition.
        await database.execute(sql`
          SELECT pg_advisory_xact_lock(hashtext('worker-job-identity'), locks.key)
          FROM (
            SELECT DISTINCT hashtext(identity) AS key
            FROM unnest(${sql.param(identities)}::text[]) AS requested(identity)
            ORDER BY key
          ) locks
        `);
        const existing = await database.select().from(this.jobsTable)
          .where(sql`${this.jobsTable.identity} = ANY(${sql.param(identities)}::text[])`);
        for (const job of existing) existingByIdentity.set(job.identity!, job);
      }

      const inserts: (typeof workerJobs.$inferInsert)[] = [];
      const ids = requests.map((request) => {
        const existing = request.identity === undefined
          ? undefined
          : existingByIdentity.get(request.identity);
        if (existing !== undefined) {
          if (!matchesIdentity(existing, request)) {
            throw new WorkerJobIdentityConflictError(request.identity!);
          }
          return existing.id;
        }

        // Assign IDs before insertion instead of relying on RETURNING order.
        const id = uuidV7();
        inserts.push({ ...request, id });
        if (request.identity !== undefined) {
          // Match the stored JSON representation for repetitions within this
          // publication, just like a subsequent publication would observe it.
          existingByIdentity.set(request.identity, {
            id,
            queue: request.queue,
            payload: JSON.parse(JSON.stringify(request.payload)),
            correlation: request.correlation === undefined
              ? null
              : JSON.parse(JSON.stringify(request.correlation)),
            groupId: request.groupId ?? null,
            executionId: request.executionId ?? null,
          });
        }
        return id;
      });

      for (let offset = 0; offset < inserts.length; offset += enqueueChunkSize) {
        await database.insert(this.jobsTable)
          .values(inserts.slice(offset, offset + enqueueChunkSize));
      }
      return ids;
    };

    // A single statement is already atomic and needs no explicit transaction.
    return identities.length === 0 && requests.length <= enqueueChunkSize
      ? publish(this.database)
      : this.database.transaction(publish);
  }

  public async reserve(
    request: ReserveJobsRequest,
  ): Promise<readonly ReservedJob[]> {
    validateReserveRequest(request);

    if (request.queues.length === 0) {
      return [];
    }

    const preferenceValues = sql.join(
      request.queues.map((preference, index) => sql`(
        ${preference.queue}::text,
        ${index + 1}::integer,
        ${preference.reservationLimit}::integer,
        ${preference.allowOverflow}::boolean
      )`),
      sql`, `,
    );
    const result = await this.database.execute(sql`
      WITH RECURSIVE preferred(
        queue,
        queue_order,
        reservation_limit,
        allow_overflow
      ) AS MATERIALIZED (
        VALUES ${preferenceValues}
      ),
      allocation(queue_order, job_ids, remaining) AS (
        SELECT 0, ARRAY[]::uuid[], ${request.totalLimit}::integer

        UNION ALL

        SELECT
          next_queue.queue_order,
          current.job_ids || picked.job_ids,
          current.remaining - cardinality(picked.job_ids)
        FROM allocation current
        CROSS JOIN LATERAL (
          SELECT preference.*
          FROM preferred preference
          WHERE preference.queue_order > current.queue_order
          ORDER BY preference.queue_order
          LIMIT 1
        ) next_queue
        CROSS JOIN LATERAL (
          SELECT COALESCE(
            array_agg(candidate.id),
            ARRAY[]::uuid[]
          ) AS job_ids
          FROM (
            SELECT job.id
            FROM ${this.jobsTable} job
            WHERE job.queue = next_queue.queue
              AND job.available_at <= statement_timestamp()
            ORDER BY job.available_at, job.id
            FOR UPDATE SKIP LOCKED
            LIMIT LEAST(
              next_queue.reservation_limit,
              current.remaining
            )
          ) candidate
        ) picked
        WHERE current.remaining > 0
      ),
      first_pass_state AS MATERIALIZED (
        SELECT job_ids, remaining
        FROM allocation
        ORDER BY queue_order DESC
        LIMIT 1
      ),
      first_pass AS MATERIALIZED (
        SELECT selected.id
        FROM first_pass_state state
        CROSS JOIN LATERAL unnest(state.job_ids) AS selected(id)
      ),
      second_pass AS MATERIALIZED (
        SELECT job.id
        FROM ${this.jobsTable} job
        INNER JOIN preferred preference
          ON preference.queue = job.queue
        CROSS JOIN first_pass_state state
        WHERE state.remaining > 0
          AND preference.allow_overflow
          AND job.available_at <= statement_timestamp()
          AND job.id <> ALL(state.job_ids)
        ORDER BY
          preference.queue_order,
          job.available_at,
          job.id
        FOR UPDATE OF job SKIP LOCKED
        LIMIT (SELECT remaining FROM first_pass_state)
      ),
      selected_jobs AS MATERIALIZED (
        SELECT id FROM first_pass
        UNION ALL
        SELECT id FROM second_pass
      )
      UPDATE ${this.jobsTable} job
      SET
        available_at = statement_timestamp()
          + (${request.leaseMs} * interval '1 millisecond'),
        state = 'reserved',
        attempt = job.attempt + 1,
        reservation_token = uuidv7(),
        reserved_at = statement_timestamp()
      FROM selected_jobs selected
      WHERE job.id = selected.id
      RETURNING
        job.id,
        job.identity,
        job.queue,
        job.payload,
        job.correlation,
        job.group_id,
        job.execution_id,
        job.attempt,
        job.available_at,
        job.reserved_at,
        job.reservation_token,
        job.created_at
    `);

    return (result.rows as unknown as ReservationRow[]).map(mapReservedJob);
  }

  public async ack(
    jobs: readonly JobReservationRef[],
  ): Promise<readonly JobReservationRef[]> {
    if (jobs.length === 0) {
      return [];
    }

    const result = await this.database.execute(sql`
      WITH requested(job_id, reservation_token) AS (
        VALUES ${reservationReferenceValues(jobs)}
      )
      DELETE FROM ${this.jobsTable} job
      USING requested
      WHERE job.id = requested.job_id
        AND job.reservation_token = requested.reservation_token
      RETURNING
        job.id AS job_id,
        requested.reservation_token
    `);

    return mapReservationReferences(result.rows);
  }

  public async retry(
    jobs: readonly RetryJobRequest[],
  ): Promise<readonly JobReservationRef[]> {
    if (jobs.length === 0) {
      return [];
    }

    const values = sql.join(jobs.map((job) => sql`(
      ${job.jobId}::uuid,
      ${job.reservationToken}::uuid,
      ${job.retryAt}::timestamptz,
      ${JSON.stringify(job.error)}::jsonb
    )`), sql`, `);
    const result = await this.database.execute(sql`
      WITH requested(job_id, reservation_token, retry_at, error) AS (
        VALUES ${values}
      )
      UPDATE ${this.jobsTable} job
      SET
        available_at = requested.retry_at,
        state = 'pending',
        last_error = requested.error,
        reserved_at = NULL,
        reservation_token = NULL
      FROM requested
      WHERE job.id = requested.job_id
        AND job.reservation_token = requested.reservation_token
      RETURNING
        job.id AS job_id,
        requested.reservation_token
    `);

    return mapReservationReferences(result.rows);
  }

  public async defer(
    jobs: readonly DeferJobRequest[],
  ): Promise<readonly JobReservationRef[]> {
    if (jobs.length === 0) {
      return [];
    }

    const values = sql.join(jobs.map((job) => sql`(
      ${job.jobId}::uuid,
      ${job.reservationToken}::uuid,
      ${job.availableAt}::timestamptz
    )`), sql`, `);
    const result = await this.database.execute(sql`
      WITH requested(job_id, reservation_token, available_at) AS (
        VALUES ${values}
      )
      UPDATE ${this.jobsTable} job
      SET
        available_at = requested.available_at,
        state = 'pending',
        attempt = GREATEST(0, job.attempt - 1),
        reserved_at = NULL,
        reservation_token = NULL
      FROM requested
      WHERE job.id = requested.job_id
        AND job.reservation_token = requested.reservation_token
      RETURNING
        job.id AS job_id,
        requested.reservation_token
    `);

    return mapReservationReferences(result.rows);
  }

  public async deadLetter(
    jobs: readonly DeadLetterJobRequest[],
  ): Promise<readonly JobReservationRef[]> {
    if (jobs.length === 0) {
      return [];
    }

    const values = sql.join(jobs.map((job) => sql`(
      ${job.jobId}::uuid,
      ${job.reservationToken}::uuid,
      ${JSON.stringify(job.error)}::jsonb
    )`), sql`, `);
    const result = await this.database.execute(sql`
      WITH requested(job_id, reservation_token, error) AS (
        VALUES ${values}
      ),
      moved AS (
        DELETE FROM ${this.jobsTable} job
        USING requested
        WHERE job.id = requested.job_id
          AND job.reservation_token = requested.reservation_token
        RETURNING
          job.*,
          requested.reservation_token AS moved_token,
          requested.error AS moved_error
      ),
      inserted AS (
        INSERT INTO ${this.deadLetterTable} (
          original_job_id,
          identity,
          queue,
          payload,
          correlation,
          group_id,
          execution_id,
          attempt,
          error,
          created_at,
          failed_at
        )
        SELECT
          moved.id,
          moved.identity,
          moved.queue,
          moved.payload,
          moved.correlation,
          moved.group_id,
          moved.execution_id,
          moved.attempt,
          moved.moved_error,
          moved.created_at,
          statement_timestamp()
        FROM moved
        RETURNING original_job_id
      )
      SELECT
        moved.id AS job_id,
        moved.moved_token AS reservation_token
      FROM moved
      INNER JOIN inserted
        ON inserted.original_job_id = moved.id
    `);

    return mapReservationReferences(result.rows);
  }

  public async release(
    jobs: readonly JobReservationRef[],
  ): Promise<readonly JobReservationRef[]> {
    if (jobs.length === 0) {
      return [];
    }

    const result = await this.database.execute(sql`
      WITH requested(job_id, reservation_token) AS (
        VALUES ${reservationReferenceValues(jobs)}
      )
      UPDATE ${this.jobsTable} job
      SET
        available_at = statement_timestamp(),
        state = 'pending',
        reserved_at = NULL,
        reservation_token = NULL
      FROM requested
      WHERE job.id = requested.job_id
        AND job.reservation_token = requested.reservation_token
      RETURNING
        job.id AS job_id,
        requested.reservation_token
    `);

    return mapReservationReferences(result.rows);
  }

  public async extendLease(
    jobs: readonly ExtendJobLeaseRequest[],
  ): Promise<readonly JobReservationRef[]> {
    if (jobs.length === 0) {
      return [];
    }

    const values = sql.join(jobs.map((job) => sql`(
      ${job.jobId}::uuid,
      ${job.reservationToken}::uuid,
      ${job.leaseMs}::integer
    )`), sql`, `);
    const result = await this.database.execute(sql`
      WITH requested(job_id, reservation_token, lease_ms) AS (
        VALUES ${values}
      )
      UPDATE ${this.jobsTable} job
      SET available_at = statement_timestamp()
        + (requested.lease_ms * interval '1 millisecond')
      FROM requested
      WHERE job.id = requested.job_id
        AND job.reservation_token = requested.reservation_token
      RETURNING
        job.id AS job_id,
        requested.reservation_token
    `);

    return mapReservationReferences(result.rows);
  }

  public async listReadyQueues(
    queues: readonly string[],
  ): Promise<readonly string[]> {
    if (queues.length === 0) {
      return [];
    }

    const rows = await this.database
      .selectDistinct({ queue: this.jobsTable.queue })
      .from(this.jobsTable)
      .leftJoin(
        this.queueControlsTable,
        eq(this.queueControlsTable.queue, this.jobsTable.queue),
      )
      .where(and(
        inArray(this.jobsTable.queue, [...queues]),
        lte(this.jobsTable.availableAt, sql`statement_timestamp()`),
        sql`COALESCE(${this.queueControlsTable.enabled}, true)`,
      ));

    return rows.map((row) => row.queue);
  }

  public async listQueueStatistics(
    queues: readonly string[],
  ): Promise<readonly WorkerQueueStatistics[]> {
    if (queues.length === 0) {
      return [];
    }

    const requestedValues = sql.join(
      queues.map((queue, index) => sql`(${queue}::text, ${index}::integer)`),
      sql`, `,
    );
    const result = await this.database.execute(sql`
      WITH requested(queue, queue_order) AS (
        VALUES ${requestedValues}
      )
      SELECT
        requested.queue,
        COALESCE(control.enabled, true) AS enabled,
        count(job.id) FILTER (
          WHERE job.available_at <= statement_timestamp()
        )::integer AS ready,
        count(job.id) FILTER (
          WHERE job.state = 'pending'
            AND job.available_at > statement_timestamp()
        )::integer AS scheduled,
        count(job.id) FILTER (
          WHERE job.state = 'reserved'
            AND job.available_at > statement_timestamp()
        )::integer AS reserved
      FROM requested
      LEFT JOIN ${this.queueControlsTable} control
        ON control.queue = requested.queue
      LEFT JOIN ${this.jobsTable} job
        ON job.queue = requested.queue
      GROUP BY requested.queue, requested.queue_order, control.enabled
      ORDER BY requested.queue_order
    `);

    return (result.rows as unknown as QueueStatisticsRow[]).map((row) => ({
      queue: row.queue,
      enabled: row.enabled,
      ready: row.ready,
      scheduled: row.scheduled,
      reserved: row.reserved,
    }));
  }

  public async setQueueEnabled(queue: string, enabled: boolean): Promise<void> {
    await this.database
      .insert(this.queueControlsTable)
      .values({ queue, enabled })
      .onConflictDoUpdate({
        target: this.queueControlsTable.queue,
        set: {
          enabled,
          updatedAt: sql`statement_timestamp()`,
        },
      });
  }
}

function reservationReferenceValues(
  jobs: readonly JobReservationRef[],
) {
  return sql.join(jobs.map((job) => sql`(
    ${job.jobId}::uuid,
    ${job.reservationToken}::uuid
  )`), sql`, `);
}

function mapReservedJob(row: ReservationRow): ReservedJob {
  return {
    id: row.id,
    ...(row.identity === null ? {} : { identity: row.identity }),
    queue: row.queue,
    payload: row.payload,
    ...(row.correlation === null ? {} : { correlation: row.correlation }),
    ...(row.group_id === null ? {} : { groupId: row.group_id }),
    ...(row.execution_id === null ? {} : { executionId: row.execution_id }),
    attempt: row.attempt,
    availableAt: row.available_at,
    reservedAt: row.reserved_at,
    reservationToken: row.reservation_token,
    createdAt: row.created_at,
  };
}

type IdentityJob = Pick<typeof workerJobs.$inferSelect,
  "id" | "queue" | "groupId" | "executionId" | "payload" | "correlation"
>;

function matchesIdentity<Payload>(
  stored: IdentityJob,
  request: EnqueueJobRequest<Payload>,
): boolean {
  return stored.queue === request.queue
    && stored.groupId === (request.groupId ?? null)
    && stored.executionId === (request.executionId ?? null)
    && isDeepStrictEqual(stored.payload, request.payload)
    && isDeepStrictEqual(stored.correlation, request.correlation ?? null);
}

function mapReservationReferences(
  rows: readonly unknown[],
): readonly JobReservationRef[] {
  return (rows as ReservationReferenceRow[]).map((row) => ({
    jobId: row.job_id,
    reservationToken: row.reservation_token,
  }));
}

function validateReserveRequest(request: ReserveJobsRequest): void {
  for (const [name, value] of [
    ["totalLimit", request.totalLimit],
    ["leaseMs", request.leaseMs],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer.`);
    }
  }

  for (const preference of request.queues) {
    if (
      !Number.isInteger(preference.reservationLimit)
      || preference.reservationLimit <= 0
    ) {
      throw new TypeError("reservationLimit must be a positive integer.");
    }
  }
}
