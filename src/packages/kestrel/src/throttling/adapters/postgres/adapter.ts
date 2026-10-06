import { sql } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";

import { uuidV7 } from "../../../utils/uuid.js";
import {
  ThrottlingBackendUnavailableError,
  ThrottlingDefinitionConflictError,
} from "../../errors.js";
import {
  throttlingRateLimitLeases,
  throttlingRateLimits,
} from "../../postgres_schema.js";
import type {
  LeasableRateLimitAdapter,
  PrunableRateLimitAdapter,
  RateLimitBatchReservationResult,
  RateLimitInspectionResult,
  RateLimitLeaseAllocation,
  RateLimitLeaseBatchResult,
  RateLimitLeaseRequest,
  RateLimitLeaseReturn,
  RateLimitPruneOptions,
  RateLimitReconciliationRequest,
  RateLimitReservationRequest,
  RateLimitReservationResult,
} from "../../types.js";

export type PostgresRateLimitDatabase = PgDatabase<
  NodePgQueryResultHKT,
  Record<string, unknown>
>;

interface ReservationRow {
  key: string;
  admitted: boolean;
  remaining: number;
}

interface InspectionRow {
  readonly conflict: boolean;
  readonly key: string;
  readonly position: number;
  readonly remaining: number;
}

interface LeaseCapacityRow {
  readonly available: number;
  readonly conflict: boolean;
  readonly key: string;
  readonly outstanding: number;
}

interface LeaseDecision {
  readonly key: string;
  readonly leaseId?: string;
  readonly leaseMs?: number;
  readonly mode: "exact" | "lease";
  readonly remaining: number;
  readonly units?: number;
}

export interface PostgresRateLimitAdapterOptions {
  readonly maxConcurrentReservations?: number;
  readonly maxPendingReservations?: number;
  readonly storageWaitTimeoutMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_MAX_CONCURRENT_RESERVATIONS = 8;
const DEFAULT_MAX_PENDING_RESERVATIONS = 1_000;
const DEFAULT_STORAGE_WAIT_TIMEOUT_MS = 1_000;

/** Exact PostgreSQL token buckets with atomic multidimensional operations. */
export class PostgresRateLimitAdapter implements
  LeasableRateLimitAdapter,
  PrunableRateLimitAdapter {
  private readonly gate: ReservationGate;

  private readonly now: () => Date;

  public constructor(
    private readonly database: PostgresRateLimitDatabase,
    options: PostgresRateLimitAdapterOptions = {},
    private readonly table: typeof throttlingRateLimits = throttlingRateLimits,
    private readonly leaseTable: typeof throttlingRateLimitLeases =
      throttlingRateLimitLeases,
  ) {
    validateOptions(options);
    this.now = options.now ?? (() => new Date());
    this.gate = new ReservationGate(
      options.maxConcurrentReservations
        ?? DEFAULT_MAX_CONCURRENT_RESERVATIONS,
      options.maxPendingReservations ?? DEFAULT_MAX_PENDING_RESERVATIONS,
      options.storageWaitTimeoutMs ?? DEFAULT_STORAGE_WAIT_TIMEOUT_MS,
    );
  }

  public async reserve(
    request: RateLimitReservationRequest,
  ): Promise<RateLimitReservationResult> {
    validateRequests([request]);

    try {
      return await this.gate.run(async () => {
        const [row] = await this.executeReservations(this.database, [request]);

        if (row === undefined) {
          throw new ThrottlingDefinitionConflictError(request.key);
        }

        return row.admitted
          ? {
              admitted: true,
              remaining: row.remaining,
              source: "authoritative",
            }
          : {
              admitted: false,
              remaining: row.remaining,
              retryAt: this.retryAt(request, row.remaining),
              source: "authoritative",
            };
      });
    } catch (error) {
      throw normalizeStorageError(error);
    }
  }

  /** Reserves every rate dimension with one set-based mutation. */
  public async reserveMany(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<RateLimitBatchReservationResult> {
    validateRequests(requests);

    if (requests.length === 0) {
      return { admitted: true, remaining: {}, source: "authoritative" };
    }

    if (requests.length === 1) {
      const request = requests[0]!;
      const result = await this.reserve(request);

      return result.admitted
        ? {
            admitted: true,
            remaining: { [request.key]: result.remaining },
            source: "authoritative",
          }
        : {
            admitted: false,
            remaining: { [request.key]: result.remaining },
            retryAt: result.retryAt,
            source: "authoritative",
          };
    }

    try {
      return await this.gate.run(async () => {
        try {
          const rows = await this.database.transaction(async (transaction) => {
            const transactionalDatabase = transaction as unknown as
              PostgresRateLimitDatabase;
            const results = await this.executeReservations(
              transactionalDatabase,
              requests,
            );
            this.assertCompleteResults(requests, results);

            if (results.some((row) => !row.admitted)) {
              throw new BatchRejectedError(results);
            }

            return results;
          });
          const remaining = Object.fromEntries(rows.map((row) =>
            [row.key, row.remaining]));

          return { admitted: true, remaining, source: "authoritative" };
        } catch (error) {
          if (!(error instanceof BatchRejectedError)) {
            throw error;
          }

          return this.createRejectedBatchResult(requests, error.results);
        }
      });
    } catch (error) {
      throw normalizeStorageError(error);
    }
  }

  /** Reconciles every dimension with one set-based atomic mutation. */
  public async reconcile(
    requests: readonly RateLimitReconciliationRequest[],
  ): Promise<Readonly<Record<string, number>>> {
    validateReconciliationRequests(requests);

    if (requests.length === 0) {
      return {};
    }

    try {
      return await this.gate.run(async () => {
        if (requests.length === 1) {
          const rows = await this.executeReconciliation(this.database, requests);
          this.assertCompleteResults(requests, rows);
          return Object.fromEntries(rows.map((row) =>
            [row.key, row.remaining]));
        }

        return this.database.transaction(async (transaction) => {
          const rows = await this.executeReconciliation(
            transaction as unknown as PostgresRateLimitDatabase,
            requests,
          );
          this.assertCompleteResults(requests, rows);
          return Object.fromEntries(rows.map((row) =>
            [row.key, row.remaining]));
        });
      });
    } catch (error) {
      throw normalizeStorageError(error);
    }
  }

  /** Issues bounded blocks or exact guard-band reservations atomically. */
  public async allocateLeases(
    ownerId: string,
    requests: readonly RateLimitLeaseRequest[],
    completedLeases: readonly RateLimitLeaseReturn[] = [],
  ): Promise<RateLimitLeaseBatchResult> {
    validateLeaseRequests(ownerId, requests, completedLeases);

    if (requests.length === 0) {
      if (completedLeases.length > 0) await this.returnLeases(completedLeases);
      return { admitted: true, allocations: {} };
    }

    try {
      return await this.gate.run(() => this.database.transaction(
        async (transaction) => {
          const database = transaction as unknown as PostgresRateLimitDatabase;

          await this.ensureLeaseBuckets(database, requests);
          await this.lockLeaseBuckets(database, requests);

          if (completedLeases.length > 0) {
            await this.returnLeasesInTransaction(database, completedLeases);
          }

          const capacities = await this.readLeaseCapacities(database, requests);
          const byKey = new Map(capacities.map((row) => [row.key, row]));

          for (const request of requests) {
            const capacity = byKey.get(request.key);

            if (capacity === undefined || capacity.conflict) {
              throw new ThrottlingDefinitionConflictError(request.key);
            }
          }

          const rejected = requests.filter((request) =>
            byKey.get(request.key)!.available + Number.EPSILON < request.cost);

          if (rejected.length > 0) {
            const remaining = Object.fromEntries(capacities.map((row) =>
              [row.key, row.available]));
            const retryAt = latestDate(rejected.map((request) =>
              this.retryAt(request, byKey.get(request.key)!.available)));

            return { admitted: false, remaining, retryAt };
          }

          const decisions = requests.map((request) =>
            createLeaseDecision(request, byKey.get(request.key)!));
          return {
            admitted: true,
            allocations: await this.commitLeaseDecisions(
              database,
              ownerId,
              decisions,
            ),
          };
        },
      ));
    } catch (error) {
      throw normalizeStorageError(error);
    }
  }

  /** Returns invalidated local capacity at most once per durable lease. */
  public async returnLeases(
    leases: readonly RateLimitLeaseReturn[],
  ): Promise<number> {
    validateLeaseReturns(leases);
    if (leases.length === 0) return 0;

    try {
      return await this.gate.run(() => this.database.transaction(
        (transaction) => this.returnLeasesInTransaction(
          transaction as unknown as PostgresRateLimitDatabase,
          leases,
        ),
      ));
    } catch (error) {
      throw normalizeStorageError(error);
    }
  }

  /** Reads every projected availability with one set-based query. */
  public async inspectMany(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<readonly RateLimitInspectionResult[]> {
    validateRequests(requests);

    try {
      return await this.gate.run(async () => {
        if (requests.length === 0) return [];
        const rows = await this.executeInspection(requests);

        return rows.map((row) => {
          const request = requests[row.position];

          if (request === undefined) {
            throw new TypeError("PostgreSQL returned an invalid inspection position.");
          }

          if (row.conflict) {
            throw new ThrottlingDefinitionConflictError(request.key);
          }

          return row.remaining + Number.EPSILON >= request.cost
            ? {
                available: true,
                remaining: row.remaining,
                source: "authoritative" as const,
              }
            : {
                available: false,
                remaining: row.remaining,
                retryAt: this.retryAt(request, row.remaining),
                source: "authoritative" as const,
              };
        });
      });
    } catch (error) {
      throw normalizeStorageError(error);
    }
  }

  /** Deletes only buckets whose full state equals a fresh bucket. */
  public async prune(options: RateLimitPruneOptions): Promise<number> {
    const limit = validatePruneLimit(options.limit ?? 1_000);

    try {
      const leases = await this.database.execute(sql`
        WITH candidates AS (
          SELECT ${this.leaseTable.id}
          FROM ${this.leaseTable}
          WHERE ${this.leaseTable.returnedAt} IS NOT NULL
            OR ${this.leaseTable.expiresAt} <= statement_timestamp()
          ORDER BY ${this.leaseTable.expiresAt}, ${this.leaseTable.id}
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM ${this.leaseTable}
        USING candidates
        WHERE ${this.leaseTable.id} = candidates.id
        RETURNING ${this.leaseTable.id}
      `);
      const remainingLimit = limit - leases.rows.length;

      if (remainingLimit === 0) return leases.rows.length;

      const result = await this.database.execute(sql`
        WITH candidates AS (
          SELECT ${this.table.key}
          FROM ${this.table}
          WHERE ${this.table.fullAt} <= statement_timestamp()
            AND NOT EXISTS (
              SELECT 1
              FROM ${this.leaseTable}
              WHERE ${this.leaseTable.rateLimitKey} = ${this.table.key}
                AND ${this.leaseTable.returnedAt} IS NULL
                AND ${this.leaseTable.expiresAt} > statement_timestamp()
            )
          ORDER BY ${this.table.fullAt}, ${this.table.key}
          LIMIT ${remainingLimit}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM ${this.table}
        USING candidates
        WHERE ${this.table.key} = candidates.key
        RETURNING ${this.table.key}
      `);

      return leases.rows.length + result.rows.length;
    } catch (error) {
      throw normalizeStorageError(error);
    }
  }

  private async ensureLeaseBuckets(
    database: PostgresRateLimitDatabase,
    requests: readonly RateLimitLeaseRequest[],
  ): Promise<void> {
    const payload = leaseRequestPayload(requests);

    await database.execute(sql`
      WITH input AS MATERIALIZED (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS request(
          key text,
          rate_limit double precision,
          period_ms double precision,
          burst double precision,
          cost double precision,
          max_lease_units double precision,
          lease_ms double precision,
          max_outstanding_units double precision,
          guard_band_units double precision
        )
      )
      INSERT INTO ${this.table} (
        ${sql.identifier("key")},
        ${sql.identifier("limit")},
        ${sql.identifier("period_ms")},
        ${sql.identifier("burst")},
        ${sql.identifier("coordination_strategy")},
        ${sql.identifier("max_lease_units")},
        ${sql.identifier("lease_ms")},
        ${sql.identifier("max_outstanding_units")},
        ${sql.identifier("guard_band_units")},
        ${sql.identifier("tokens")},
        ${sql.identifier("refilled_at")},
        ${sql.identifier("full_at")},
        ${sql.identifier("last_admitted")}
      )
      SELECT
        input.key,
        input.rate_limit,
        input.period_ms,
        input.burst,
        'leased',
        input.max_lease_units,
        input.lease_ms,
        input.max_outstanding_units,
        input.guard_band_units,
        input.burst,
        statement_timestamp(),
        statement_timestamp(),
        true
      FROM input
      ORDER BY input.key
      ON CONFLICT (${sql.identifier("key")}) DO NOTHING
    `);
  }

  private async readLeaseCapacities(
    database: PostgresRateLimitDatabase,
    requests: readonly RateLimitLeaseRequest[],
  ): Promise<readonly LeaseCapacityRow[]> {
    const payload = leaseRequestPayload(requests);
    const result = await database.execute(sql`
      WITH input AS MATERIALIZED (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS request(
          key text,
          rate_limit double precision,
          period_ms double precision,
          burst double precision,
          cost double precision,
          max_lease_units double precision,
          lease_ms double precision,
          max_outstanding_units double precision,
          guard_band_units double precision
        )
      )
      SELECT
        input.key,
        (${this.table.limit} <> input.rate_limit
          OR ${this.table.periodMs} <> input.period_ms
          OR ${this.table.burst} <> input.burst
          OR ${this.table.coordinationStrategy} <> 'leased'
          OR ${this.table.maxLeaseUnits} IS DISTINCT FROM input.max_lease_units
          OR ${this.table.leaseMs} IS DISTINCT FROM input.lease_ms
          OR ${this.table.maxOutstandingUnits} IS DISTINCT FROM input.max_outstanding_units
          OR ${this.table.guardBandUnits} IS DISTINCT FROM input.guard_band_units) AS conflict,
        LEAST(
          input.burst,
          ${this.table.tokens} + (
            GREATEST(
              0,
              EXTRACT(EPOCH FROM (
                statement_timestamp() - ${this.table.refilledAt}
              )) * 1000
            ) * input.rate_limit / input.period_ms
          )
        ) AS available,
        COALESCE(active.units, 0) AS outstanding
      FROM input
      JOIN ${this.table} ON ${this.table.key} = input.key
      LEFT JOIN LATERAL (
        SELECT SUM(${this.leaseTable.units}) AS units
        FROM ${this.leaseTable}
        WHERE ${this.leaseTable.rateLimitKey} = input.key
          AND ${this.leaseTable.returnedAt} IS NULL
          AND ${this.leaseTable.expiresAt} > statement_timestamp()
      ) active ON true
      ORDER BY input.key
    `);

    return result.rows.map((row) => ({
      key: String(row.key),
      conflict: Boolean(row.conflict),
      available: Number(row.available),
      outstanding: Number(row.outstanding),
    }));
  }

  private async lockLeaseBuckets(
    database: PostgresRateLimitDatabase,
    requests: readonly RateLimitLeaseRequest[],
  ): Promise<void> {
    const keys = [...requests]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(({ key }) => ({ key }));

    // The following statement gets a fresh READ COMMITTED snapshot only after
    // these locks are held, so it sees leases issued by a transaction we waited
    // for and can enforce maxOutstandingUnits across processes.
    await database.execute(sql`
      WITH input AS MATERIALIZED (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(keys)}::jsonb) AS request(
          key text
        )
      )
      SELECT ${this.table.key}
      FROM input
      JOIN ${this.table} ON ${this.table.key} = input.key
      ORDER BY ${this.table.key}
      FOR UPDATE OF ${this.table}
    `);
  }

  private async commitLeaseDecisions(
    database: PostgresRateLimitDatabase,
    ownerId: string,
    decisions: readonly LeaseDecision[],
  ): Promise<Readonly<Record<string, RateLimitLeaseAllocation>>> {
    const result = await database.execute(sql`
      WITH input AS MATERIALIZED (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(leaseDecisionPayload(decisions))}::jsonb) AS decision(
          key text,
          mode text,
          remaining double precision,
          lease_id text,
          units double precision,
          lease_ms double precision
        )
      ), updated AS (
        UPDATE ${this.table}
        SET
          ${sql.identifier("tokens")} = input.remaining,
          ${sql.identifier("refilled_at")} = statement_timestamp(),
          ${sql.identifier("full_at")} = statement_timestamp() + (
            ((${this.table.burst} - input.remaining)
              * ${this.table.periodMs} / ${this.table.limit})
            * interval '1 millisecond'
          ),
          ${sql.identifier("last_admitted")} = true
        FROM input
        WHERE ${this.table.key} = input.key
        RETURNING ${this.table.key}
      ), issued AS (
        INSERT INTO ${this.leaseTable} (
          ${sql.identifier("id")},
          ${sql.identifier("rate_limit_key")},
          ${sql.identifier("owner_id")},
          ${sql.identifier("units")},
          ${sql.identifier("expires_at")},
          ${sql.identifier("returned_at")},
          ${sql.identifier("returned_units")},
          ${sql.identifier("created_at")}
        )
        SELECT
          input.lease_id,
          input.key,
          ${ownerId},
          input.units,
          statement_timestamp()
            + input.lease_ms * interval '1 millisecond',
          NULL,
          0,
          statement_timestamp()
        FROM input
        WHERE input.mode = 'lease'
          AND EXISTS (SELECT 1 FROM updated WHERE updated.key = input.key)
        RETURNING
          ${this.leaseTable.id} AS lease_id,
          ${this.leaseTable.rateLimitKey} AS key,
          ${this.leaseTable.units} AS units,
          ${this.leaseTable.expiresAt} AS expires_at
      )
      SELECT
        input.key,
        input.mode,
        input.remaining,
        issued.lease_id,
        issued.units,
        issued.expires_at
      FROM input
      LEFT JOIN issued ON issued.key = input.key
      ORDER BY input.key
    `);

    return Object.fromEntries(result.rows.map((row) => {
      const key = String(row.key);

      return row.mode === "lease"
        ? [key, {
            mode: "lease",
            leaseId: String(row.lease_id),
            units: Number(row.units),
            expiresAt: new Date(String(row.expires_at)),
            remaining: Number(row.remaining),
          } satisfies RateLimitLeaseAllocation]
        : [key, {
            mode: "exact",
            remaining: Number(row.remaining),
          } satisfies RateLimitLeaseAllocation];
    }));
  }

  private async returnLeasesInTransaction(
    database: PostgresRateLimitDatabase,
    leases: readonly RateLimitLeaseReturn[],
  ): Promise<number> {
    const result = await database.execute(sql`
      WITH input AS MATERIALIZED (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(leaseReturnPayload(leases))}::jsonb) AS returned(
          key text,
          lease_id text,
          remaining double precision
        )
      ), returned_keys AS MATERIALIZED (
        SELECT DISTINCT key FROM input
      ), locked_buckets AS MATERIALIZED (
        SELECT ${this.table.key}
        FROM returned_keys
        JOIN ${this.table} ON ${this.table.key} = returned_keys.key
        ORDER BY ${this.table.key}
        FOR UPDATE OF ${this.table}
      ), eligible AS MATERIALIZED (
        SELECT
          ${this.leaseTable.id} AS lease_id,
          ${this.leaseTable.rateLimitKey} AS key,
          CASE
            WHEN ${this.leaseTable.expiresAt} > statement_timestamp()
            THEN LEAST(${this.leaseTable.units}, GREATEST(0, input.remaining))
            ELSE 0
          END AS units
        FROM ${this.leaseTable}
        JOIN input
          ON input.lease_id = ${this.leaseTable.id}
          AND input.key = ${this.leaseTable.rateLimitKey}
        LEFT JOIN locked_buckets
          ON locked_buckets.key = ${this.leaseTable.rateLimitKey}
        WHERE ${this.leaseTable.returnedAt} IS NULL
        ORDER BY ${this.leaseTable.rateLimitKey}, ${this.leaseTable.id}
        FOR UPDATE OF ${this.leaseTable}
      ), marked AS (
        UPDATE ${this.leaseTable}
        SET
          ${sql.identifier("returned_at")} = statement_timestamp(),
          ${sql.identifier("returned_units")} = eligible.units
        FROM eligible
        WHERE ${this.leaseTable.id} = eligible.lease_id
        RETURNING eligible.key, eligible.units
      ), refunds AS (
        SELECT key, SUM(units) AS units
        FROM marked
        GROUP BY key
      ), calculated AS MATERIALIZED (
        SELECT
          ${this.table.key} AS key,
          LEAST(
            ${this.table.burst},
            ${this.table.tokens} + (
              GREATEST(
                0,
                EXTRACT(EPOCH FROM (
                  statement_timestamp() - ${this.table.refilledAt}
                )) * 1000
              ) * ${this.table.limit} / ${this.table.periodMs}
            ) + refunds.units
          ) AS remaining
        FROM ${this.table}
        JOIN refunds ON refunds.key = ${this.table.key}
        ORDER BY ${this.table.key}
        FOR UPDATE OF ${this.table}
      ), refunded AS (
        UPDATE ${this.table}
        SET
          ${sql.identifier("tokens")} = calculated.remaining,
          ${sql.identifier("refilled_at")} = statement_timestamp(),
          ${sql.identifier("full_at")} = statement_timestamp() + (
            ((${this.table.burst} - calculated.remaining)
              * ${this.table.periodMs} / ${this.table.limit})
            * interval '1 millisecond'
          )
        FROM calculated
        WHERE ${this.table.key} = calculated.key
        RETURNING ${this.table.key}
      )
      SELECT COUNT(*)::integer AS count FROM marked
    `);

    return Number(result.rows[0]?.count ?? 0);
  }

  private async executeReservations(
    database: PostgresRateLimitDatabase,
    requests: readonly RateLimitReservationRequest[],
  ): Promise<readonly ReservationRow[]> {
    const payload = reservationPayload(requests);
    // Lateral stages keep each transition value explicit and evaluate the
    // incoming cost directly instead of reconstructing it from inserted state.
    const result = await database.execute(sql`
      WITH input AS MATERIALIZED (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS request(
          key text,
          rate_limit double precision,
          period_ms double precision,
          burst double precision,
          cost double precision,
          coordination_strategy text,
          max_lease_units double precision,
          lease_ms double precision,
          max_outstanding_units double precision,
          guard_band_units double precision
        )
      )
      INSERT INTO ${this.table} (
        ${sql.identifier("key")},
        ${sql.identifier("limit")},
        ${sql.identifier("period_ms")},
        ${sql.identifier("burst")},
        ${sql.identifier("coordination_strategy")},
        ${sql.identifier("max_lease_units")},
        ${sql.identifier("lease_ms")},
        ${sql.identifier("max_outstanding_units")},
        ${sql.identifier("guard_band_units")},
        ${sql.identifier("tokens")},
        ${sql.identifier("refilled_at")},
        ${sql.identifier("full_at")},
        ${sql.identifier("last_admitted")}
      )
      SELECT
        input.key,
        input.rate_limit,
        input.period_ms,
        input.burst,
        input.coordination_strategy,
        input.max_lease_units,
        input.lease_ms,
        input.max_outstanding_units,
        input.guard_band_units,
        input.burst - input.cost,
        statement_timestamp(),
        statement_timestamp() + (
          input.cost * input.period_ms / input.rate_limit
          * interval '1 millisecond'
        ),
        true
      FROM input
      ORDER BY input.key
      ON CONFLICT (${sql.identifier("key")}) DO UPDATE SET
        (
          ${sql.identifier("tokens")},
          ${sql.identifier("refilled_at")},
          ${sql.identifier("full_at")},
          ${sql.identifier("last_admitted")}
        ) = (
          SELECT
            next_state.remaining,
            state.refilled_at,
            state.refilled_at + (
              ((excluded.burst - next_state.remaining)
                * excluded.period_ms
                / excluded.${sql.identifier("limit")})
              * interval '1 millisecond'
            ),
            decision.admitted
          FROM LATERAL (
            SELECT
              LEAST(
                excluded.burst,
                ${this.table.tokens} + (
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (
                      statement_timestamp() - ${this.table.refilledAt}
                    )) * 1000
                  ) * excluded.${sql.identifier("limit")}
                    / excluded.period_ms
                )
              ) AS available,
              (
                SELECT input.cost
                FROM input
                WHERE input.key = excluded.key
              ) AS cost,
              GREATEST(
                ${this.table.refilledAt},
                statement_timestamp()
              ) AS refilled_at
          ) AS state
          CROSS JOIN LATERAL (
            SELECT state.available + 1e-12 >= state.cost AS admitted
          ) AS decision
          CROSS JOIN LATERAL (
            SELECT CASE WHEN decision.admitted
              THEN GREATEST(0, state.available - state.cost)
              ELSE state.available
            END AS remaining
          ) AS next_state
        )
      WHERE ${this.table.limit} = excluded.${sql.identifier("limit")}
        AND ${this.table.periodMs} = excluded.period_ms
        AND ${this.table.burst} = excluded.burst
        AND ${this.table.coordinationStrategy} = excluded.coordination_strategy
        AND ${this.table.maxLeaseUnits} IS NOT DISTINCT FROM excluded.max_lease_units
        AND ${this.table.leaseMs} IS NOT DISTINCT FROM excluded.lease_ms
        AND ${this.table.maxOutstandingUnits} IS NOT DISTINCT FROM excluded.max_outstanding_units
        AND ${this.table.guardBandUnits} IS NOT DISTINCT FROM excluded.guard_band_units
      RETURNING
        ${this.table.key} AS key,
        ${this.table.lastAdmitted} AS admitted,
        ${this.table.tokens} AS remaining
    `);

    return result.rows.map((row) => ({
      key: String(row.key),
      admitted: Boolean(row.admitted),
      remaining: Number(row.remaining),
    }));
  }

  private async executeReconciliation(
    database: PostgresRateLimitDatabase,
    requests: readonly RateLimitReconciliationRequest[],
  ): Promise<readonly Pick<ReservationRow, "key" | "remaining">[]> {
    const payload = reconciliationPayload(requests);
    const available = sql<number>`LEAST(
      excluded.burst,
      ${this.table.tokens} + (
        GREATEST(
          0,
          EXTRACT(EPOCH FROM (
            statement_timestamp() - ${this.table.refilledAt}
          )) * 1000
        ) * excluded.${sql.identifier("limit")}
          / excluded.period_ms
      )
    )`;
    const delta = sql<number>`(
      SELECT input.delta FROM input WHERE input.key = excluded.key
    )`;
    const remaining = sql<number>`LEAST(
      excluded.burst,
      ${available} - ${delta}
    )`;
    const refilledAt = sql<Date>`GREATEST(
      ${this.table.refilledAt},
      statement_timestamp()
    )`;
    const fullAt = sql<Date>`${refilledAt} + (
      ((excluded.burst - ${remaining})
        * excluded.period_ms
        / excluded.${sql.identifier("limit")})
      * interval '1 millisecond'
    )`;
    const result = await database.execute(sql`
      WITH input AS MATERIALIZED (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS adjustment(
          key text,
          rate_limit double precision,
          period_ms double precision,
          burst double precision,
          delta double precision,
          coordination_strategy text,
          max_lease_units double precision,
          lease_ms double precision,
          max_outstanding_units double precision,
          guard_band_units double precision
        )
      )
      INSERT INTO ${this.table} (
        ${sql.identifier("key")},
        ${sql.identifier("limit")},
        ${sql.identifier("period_ms")},
        ${sql.identifier("burst")},
        ${sql.identifier("coordination_strategy")},
        ${sql.identifier("max_lease_units")},
        ${sql.identifier("lease_ms")},
        ${sql.identifier("max_outstanding_units")},
        ${sql.identifier("guard_band_units")},
        ${sql.identifier("tokens")},
        ${sql.identifier("refilled_at")},
        ${sql.identifier("full_at")},
        ${sql.identifier("last_admitted")}
      )
      SELECT
        input.key,
        input.rate_limit,
        input.period_ms,
        input.burst,
        input.coordination_strategy,
        input.max_lease_units,
        input.lease_ms,
        input.max_outstanding_units,
        input.guard_band_units,
        LEAST(input.burst, input.burst - input.delta),
        statement_timestamp(),
        statement_timestamp() + (
          GREATEST(0, input.delta) * input.period_ms / input.rate_limit
          * interval '1 millisecond'
        ),
        true
      FROM input
      ORDER BY input.key
      ON CONFLICT (${sql.identifier("key")}) DO UPDATE SET
        ${sql.identifier("tokens")} = ${remaining},
        ${sql.identifier("refilled_at")} = ${refilledAt},
        ${sql.identifier("full_at")} = ${fullAt}
      WHERE ${this.table.limit} = excluded.${sql.identifier("limit")}
        AND ${this.table.periodMs} = excluded.period_ms
        AND ${this.table.burst} = excluded.burst
        AND ${this.table.coordinationStrategy} = excluded.coordination_strategy
        AND ${this.table.maxLeaseUnits} IS NOT DISTINCT FROM excluded.max_lease_units
        AND ${this.table.leaseMs} IS NOT DISTINCT FROM excluded.lease_ms
        AND ${this.table.maxOutstandingUnits} IS NOT DISTINCT FROM excluded.max_outstanding_units
        AND ${this.table.guardBandUnits} IS NOT DISTINCT FROM excluded.guard_band_units
      RETURNING ${this.table.key} AS key, ${this.table.tokens} AS remaining
    `);

    return result.rows.map((row) => ({
      key: String(row.key),
      remaining: Number(row.remaining),
    }));
  }

  private async executeInspection(
    requests: readonly RateLimitReservationRequest[],
  ): Promise<readonly InspectionRow[]> {
    const payload = inspectionPayload(requests);
    const result = await this.database.execute(sql`
      WITH input AS MATERIALIZED (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS request(
          position integer,
          key text,
          rate_limit double precision,
          period_ms double precision,
          burst double precision,
          cost double precision,
          coordination_strategy text,
          max_lease_units double precision,
          lease_ms double precision,
          max_outstanding_units double precision,
          guard_band_units double precision
        )
      )
      SELECT
        input.position,
        input.key,
        (${this.table.key} IS NOT NULL AND (
          ${this.table.limit} <> input.rate_limit
          OR ${this.table.periodMs} <> input.period_ms
          OR ${this.table.burst} <> input.burst
          OR ${this.table.coordinationStrategy} <> input.coordination_strategy
          OR ${this.table.maxLeaseUnits} IS DISTINCT FROM input.max_lease_units
          OR ${this.table.leaseMs} IS DISTINCT FROM input.lease_ms
          OR ${this.table.maxOutstandingUnits} IS DISTINCT FROM input.max_outstanding_units
          OR ${this.table.guardBandUnits} IS DISTINCT FROM input.guard_band_units
        )) AS conflict,
        CASE WHEN ${this.table.key} IS NULL THEN input.burst ELSE LEAST(
          input.burst,
          ${this.table.tokens} + (
            GREATEST(
              0,
              EXTRACT(EPOCH FROM (
                statement_timestamp() - ${this.table.refilledAt}
              )) * 1000
            ) * input.rate_limit / input.period_ms
          )
        ) END AS remaining
      FROM input
      LEFT JOIN ${this.table} ON ${this.table.key} = input.key
      ORDER BY input.position
    `);

    return result.rows.map((row) => ({
      position: Number(row.position),
      key: String(row.key),
      conflict: Boolean(row.conflict),
      remaining: Number(row.remaining),
    }));
  }

  private assertCompleteResults(
    requests: readonly RateLimitReservationRequest[],
    rows: readonly Pick<ReservationRow, "key">[],
  ): void {
    const returned = new Set(rows.map((row) => row.key));
    const conflict = requests.find((request) => !returned.has(request.key));

    if (conflict !== undefined) {
      throw new ThrottlingDefinitionConflictError(conflict.key);
    }
  }

  private createRejectedBatchResult(
    requests: readonly RateLimitReservationRequest[],
    rows: readonly ReservationRow[],
  ): RateLimitBatchReservationResult {
    const byKey = new Map(requests.map((request) => [request.key, request]));
    const retryAt = rows
      .filter((row) => !row.admitted)
      .map((row) => this.retryAt(byKey.get(row.key)!, row.remaining));

    return {
      admitted: false,
      remaining: Object.fromEntries(rows.map((row) =>
        [row.key, row.remaining])),
      retryAt: latestDate(retryAt),
      source: "authoritative",
    };
  }

  private retryAt(
    request: RateLimitReservationRequest,
    remaining: number,
  ): Date {
    return new Date(this.getNowMs() + calculateWaitMs(request, remaining));
  }

  private getNowMs(): number {
    const value = this.now().getTime();

    if (!Number.isFinite(value)) {
      throw new TypeError("The throttling clock returned an invalid date.");
    }

    return value;
  }
}

class BatchRejectedError extends Error {
  public constructor(public readonly results: readonly ReservationRow[]) {
    super("The atomic rate limit batch was rejected.");
  }
}

/** Small semaphore preventing throttling from monopolizing a shared pool. */
class ReservationGate {
  private active = 0;

  private readonly waiters: Array<() => void> = [];

  public constructor(
    private readonly capacity: number,
    private readonly maxPending: number,
    private readonly waitTimeoutMs: number,
  ) {}

  public async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    await this.enter();

    try {
      return await operation();
    } finally {
      this.leave();
    }
  }

  private async enter(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return;
    }

    if (this.waiters.length >= this.maxPending) {
      throw new ThrottlingBackendUnavailableError({
        cause: new Error("The throttling storage queue is full."),
      });
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.active += 1;
        resolve();
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(waiter);

        if (index >= 0) this.waiters.splice(index, 1);
        reject(new ThrottlingBackendUnavailableError({
          cause: new Error("Timed out waiting for throttling storage capacity."),
        }));
      }, this.waitTimeoutMs);

      this.waiters.push(waiter);
    });
  }

  private leave(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

function normalizeStorageError(error: unknown): Error {
  if (
    error instanceof ThrottlingDefinitionConflictError
    || error instanceof ThrottlingBackendUnavailableError
  ) {
    return error;
  }

  return new ThrottlingBackendUnavailableError({ cause: error });
}

function calculateWaitMs(
  request: RateLimitReservationRequest,
  remaining: number,
): number {
  return Math.max(
    1,
    Math.ceil(
      ((request.cost - remaining) * request.periodMs) / request.limit,
    ),
  );
}

function latestDate(dates: readonly Date[]): Date {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function createLeaseDecision(
  request: RateLimitLeaseRequest,
  capacity: LeaseCapacityRow,
): LeaseDecision {
  const headroom = Math.max(
    0,
    request.coordination.maxOutstandingUnits - capacity.outstanding,
  );
  const exact = capacity.available
      <= request.coordination.guardBandUnits + request.cost + Number.EPSILON
    || headroom + Number.EPSILON < request.cost;

  if (exact) {
    return {
      key: request.key,
      mode: "exact",
      remaining: Math.max(0, capacity.available - request.cost),
    };
  }

  const units = Math.min(
    request.coordination.maxLeaseUnits,
    headroom,
    Math.max(
      request.cost,
      capacity.available - request.coordination.guardBandUnits,
    ),
  );

  return {
    key: request.key,
    mode: "lease",
    remaining: Math.max(0, capacity.available - units),
    leaseId: uuidV7(),
    leaseMs: request.coordination.leaseMs,
    units,
  };
}

function reservationPayload(
  requests: readonly RateLimitReservationRequest[],
) {
  return [...requests]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((request) => ({
      key: request.key,
      rate_limit: request.limit,
      period_ms: request.periodMs,
      burst: request.burst,
      cost: request.cost,
      ...coordinationPayload(request),
    }));
}

function reconciliationPayload(
  requests: readonly RateLimitReconciliationRequest[],
) {
  return [...requests]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((request) => ({
      key: request.key,
      rate_limit: request.limit,
      period_ms: request.periodMs,
      burst: request.burst,
      delta: request.actualCost - request.estimatedCost,
      ...coordinationPayload(request),
    }));
}

function inspectionPayload(
  requests: readonly RateLimitReservationRequest[],
) {
  return requests.map((request, position) => ({
    position,
    key: request.key,
    rate_limit: request.limit,
    period_ms: request.periodMs,
    burst: request.burst,
    cost: request.cost,
    ...coordinationPayload(request),
  }));
}

function coordinationPayload(request: RateLimitReservationRequest) {
  const coordination = request.coordination;

  return coordination?.strategy === "leased"
    ? {
        coordination_strategy: "leased",
        max_lease_units: coordination.maxLeaseUnits,
        lease_ms: coordination.leaseMs,
        max_outstanding_units: coordination.maxOutstandingUnits,
        guard_band_units: coordination.guardBandUnits,
      }
    : {
        coordination_strategy: "exact",
        max_lease_units: null,
        lease_ms: null,
        max_outstanding_units: null,
        guard_band_units: null,
      };
}

function leaseRequestPayload(
  requests: readonly RateLimitLeaseRequest[],
) {
  return [...requests]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((request) => ({
      key: request.key,
      rate_limit: request.limit,
      period_ms: request.periodMs,
      burst: request.burst,
      cost: request.cost,
      max_lease_units: request.coordination.maxLeaseUnits,
      lease_ms: request.coordination.leaseMs,
      max_outstanding_units: request.coordination.maxOutstandingUnits,
      guard_band_units: request.coordination.guardBandUnits,
    }));
}

function leaseDecisionPayload(decisions: readonly LeaseDecision[]) {
  return decisions.map((decision) => ({
    key: decision.key,
    mode: decision.mode,
    remaining: decision.remaining,
    lease_id: decision.leaseId ?? null,
    units: decision.units ?? null,
    lease_ms: decision.leaseMs ?? null,
  }));
}

function leaseReturnPayload(leases: readonly RateLimitLeaseReturn[]) {
  return leases.map((lease) => ({
    key: lease.key,
    lease_id: lease.leaseId,
    remaining: lease.remaining,
  }));
}

function validateRequests(
  requests: readonly RateLimitReservationRequest[],
): void {
  const keys = new Set<string>();

  for (const request of requests) {
    validateRequest(request);

    if (keys.has(request.key)) {
      throw new TypeError(`Rate limit adapter key "${request.key}" is duplicated.`);
    }

    keys.add(request.key);
  }
}

function validateReconciliationRequests(
  requests: readonly RateLimitReconciliationRequest[],
): void {
  validateRequests(requests);

  for (const request of requests) {
    for (const [name, value] of [
      ["actualCost", request.actualCost],
      ["estimatedCost", request.estimatedCost],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative finite number.`);
      }
    }
  }
}

function validateLeaseRequests(
  ownerId: string,
  requests: readonly RateLimitLeaseRequest[],
  completedLeases: readonly RateLimitLeaseReturn[],
): void {
  if (ownerId.trim().length === 0) {
    throw new TypeError("A rate limit lease owner id cannot be empty.");
  }

  validateRequests(requests);
  validateLeaseReturns(completedLeases);
  const requestKeys = new Set(requests.map(({ key }) => key));

  for (const lease of completedLeases) {
    if (!requestKeys.has(lease.key)) {
      throw new TypeError(
        "Completed leases must belong to the allocation request keys.",
      );
    }
  }

  for (const request of requests) {
    if (request.coordination.strategy !== "leased") {
      throw new TypeError("Lease allocation requires leased coordination.");
    }

    for (const [name, value] of [
      ["maxLeaseUnits", request.coordination.maxLeaseUnits],
      ["leaseMs", request.coordination.leaseMs],
      ["maxOutstandingUnits", request.coordination.maxOutstandingUnits],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new TypeError(`${name} must be positive and finite.`);
      }
    }

    if (
      !Number.isFinite(request.coordination.guardBandUnits)
      || request.coordination.guardBandUnits < 0
    ) {
      throw new TypeError("guardBandUnits must be non-negative and finite.");
    }

    if (request.coordination.maxLeaseUnits > request.burst) {
      throw new TypeError("maxLeaseUnits cannot exceed burst.");
    }

    if (
      request.coordination.maxOutstandingUnits
      < request.coordination.maxLeaseUnits
    ) {
      throw new TypeError(
        "maxOutstandingUnits cannot be smaller than maxLeaseUnits.",
      );
    }
  }
}

function validateLeaseReturns(leases: readonly RateLimitLeaseReturn[]): void {
  const ids = new Set<string>();

  for (const lease of leases) {
    if (lease.key.length === 0 || lease.leaseId.length === 0) {
      throw new TypeError("Returned lease identifiers cannot be empty.");
    }

    if (!Number.isFinite(lease.remaining) || lease.remaining < 0) {
      throw new TypeError("Returned lease remaining units must be non-negative.");
    }

    if (ids.has(lease.leaseId)) {
      throw new TypeError(`Rate limit lease "${lease.leaseId}" is duplicated.`);
    }

    ids.add(lease.leaseId);
  }
}

function validateRequest(request: RateLimitReservationRequest): void {
  if (request.key.length === 0) {
    throw new TypeError("Rate limit adapter keys cannot be empty.");
  }

  for (const [name, value] of [
    ["limit", request.limit],
    ["periodMs", request.periodMs],
    ["burst", request.burst],
    ["cost", request.cost],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite number.`);
    }
  }

  if (request.cost > request.burst) {
    throw new TypeError("cost cannot exceed burst.");
  }
}

function validateOptions(options: PostgresRateLimitAdapterOptions): void {
  const concurrency = options.maxConcurrentReservations
    ?? DEFAULT_MAX_CONCURRENT_RESERVATIONS;
  const timeout = options.storageWaitTimeoutMs
    ?? DEFAULT_STORAGE_WAIT_TIMEOUT_MS;
  const maxPending = options.maxPendingReservations
    ?? DEFAULT_MAX_PENDING_RESERVATIONS;

  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new TypeError("maxConcurrentReservations must be a positive integer.");
  }

  if (!Number.isInteger(maxPending) || maxPending < 0) {
    throw new TypeError("maxPendingReservations must be a non-negative integer.");
  }

  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError("storageWaitTimeoutMs must be positive and finite.");
  }
}

function validatePruneLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("Throttling prune limit must be a positive integer.");
  }

  return limit;
}
