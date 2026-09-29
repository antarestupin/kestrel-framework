import {
  and,
  eq,
  gt,
  lte,
  sql,
} from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";

import { lockLeases } from "../../postgres_schema.js";
import type {
  LockAcquireRequest,
  LockAdapter,
  LockExtendRequest,
  LockLease,
  LockPruneOptions,
  LockReleaseRequest,
  PrunableLockAdapter,
} from "../../types.js";

export type PostgresLockDatabase = PgDatabase<
  NodePgQueryResultHKT,
  Record<string, unknown>
>;

interface ExtendedLeaseRow extends Record<string, unknown> {
  key: string;
  owner_id: string;
  expires_at: Date | string;
  fencing_token: bigint | string;
}

/** Distributed lock adapter whose lease decisions use PostgreSQL time. */
export class PostgresLockAdapter implements LockAdapter, PrunableLockAdapter {
  public constructor(
    private readonly database: PostgresLockDatabase,
    private readonly table: typeof lockLeases = lockLeases,
  ) {}

  public async tryAcquire(
    request: LockAcquireRequest,
  ): Promise<LockLease | undefined> {
    const expiresAt = this.expiration(request.ttlMs);
    const [lease] = await this.database
      .insert(this.table)
      .values({
        key: request.key,
        ownerId: request.ownerId,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: this.table.key,
        set: {
          ownerId: request.ownerId,
          // The proposed insert consumes the next sequence value before the
          // conflict is resolved, giving every successful owner a newer token.
          fencingToken: sql.raw('excluded."fencing_token"'),
          expiresAt,
        },
        setWhere: lte(
          this.table.expiresAt,
          sql`statement_timestamp()`,
        ),
      })
      .returning({
        key: this.table.key,
        ownerId: this.table.ownerId,
        expiresAt: this.table.expiresAt,
        fencingToken: this.table.fencingToken,
      });

    return lease;
  }

  /** Acquires every lease with one set-based mutation and one transaction. */
  public async tryAcquireMany(
    requests: readonly LockAcquireRequest[],
  ): Promise<readonly LockLease[] | undefined> {
    validateUniqueRequests(requests);

    if (requests.length === 0) {
      return [];
    }

    if (requests.length === 1) {
      const lease = await this.tryAcquire(requests[0]!);
      return lease === undefined ? undefined : [lease];
    }

    const sortedRequests = [...requests].sort((left, right) =>
      compareKeys(left.key, right.key));

    try {
      const leases = await this.database.transaction(async (transaction) => {
        const rows = await transaction
          .insert(this.table)
          .values(sortedRequests.map((request) => ({
            key: request.key,
            ownerId: request.ownerId,
            // Each request may select its own effective TTL.
            expiresAt: this.expiration(request.ttlMs),
          })))
          .onConflictDoUpdate({
            target: this.table.key,
            set: {
              ownerId: sql.raw('excluded."owner_id"'),
              fencingToken: sql.raw('excluded."fencing_token"'),
              expiresAt: sql.raw('excluded."expires_at"'),
            },
            setWhere: lte(
              this.table.expiresAt,
              sql`statement_timestamp()`,
            ),
          })
          .returning({
            key: this.table.key,
            ownerId: this.table.ownerId,
            expiresAt: this.table.expiresAt,
            fencingToken: this.table.fencingToken,
          });

        // Throwing rolls the transaction back, including successful rows.
        if (rows.length !== sortedRequests.length) {
          throw new BatchAcquisitionContendedError();
        }

        const byKey = new Map(rows.map((lease) => [lease.key, lease]));
        return requests.map((request) => byKey.get(request.key)!);
      });

      return leases;
    } catch (error) {
      if (error instanceof BatchAcquisitionContendedError) {
        return undefined;
      }

      throw error;
    }
  }

  public async extend(
    request: LockExtendRequest,
  ): Promise<LockLease | undefined> {
    const [lease] = await this.database
      .update(this.table)
      .set({ expiresAt: this.expiration(request.ttlMs) })
      .where(and(
        eq(this.table.key, request.key),
        eq(this.table.ownerId, request.ownerId),
        gt(this.table.expiresAt, sql`statement_timestamp()`),
      ))
      .returning({
        key: this.table.key,
        ownerId: this.table.ownerId,
        expiresAt: this.table.expiresAt,
        fencingToken: this.table.fencingToken,
      });

    return lease;
  }

  /** Extends every owned lease with one atomic set-based update. */
  public async extendMany(
    requests: readonly LockExtendRequest[],
  ): Promise<readonly LockLease[] | undefined> {
    validateUniqueRequests(requests);

    if (requests.length === 0) {
      return [];
    }

    if (requests.length === 1) {
      const lease = await this.extend(requests[0]!);
      return lease === undefined ? undefined : [lease];
    }

    const sortedRequests = [...requests].sort((left, right) =>
      compareKeys(left.key, right.key));
    const values = sql.join(sortedRequests.map((request) => sql`(
      ${request.key}::text,
      ${request.ownerId}::text,
      ${request.ttlMs}::double precision
    )`), sql`, `);

    try {
      return await this.database.transaction(async (transaction) => {
        const result = await transaction.execute<ExtendedLeaseRow>(sql`
          WITH requested(key, owner_id, ttl_ms) AS (
            VALUES ${values}
          )
          UPDATE ${this.table} lease
          SET expires_at = statement_timestamp()
            + (requested.ttl_ms * interval '1 millisecond')
          FROM requested
          WHERE lease.key = requested.key
            AND lease.owner_id = requested.owner_id
            AND lease.expires_at > statement_timestamp()
          RETURNING
            lease.key,
            lease.owner_id,
            lease.expires_at,
            lease.fencing_token
        `);

        // Roll back successful rows when one lease is missing, expired or lost.
        if (result.rows.length !== sortedRequests.length) {
          throw new BatchExtensionLostError();
        }

        const byKey = new Map(result.rows.map((row) => [row.key, row]));
        return requests.map((request) => {
          const row = byKey.get(request.key)!;
          return {
            key: row.key,
            ownerId: row.owner_id,
            expiresAt: row.expires_at instanceof Date
              ? row.expires_at
              : new Date(row.expires_at),
            fencingToken: BigInt(row.fencing_token),
          };
        });
      });
    } catch (error) {
      if (error instanceof BatchExtensionLostError) {
        return undefined;
      }

      throw error;
    }
  }

  public async release(request: LockReleaseRequest): Promise<boolean> {
    const deleted = await this.database
      .delete(this.table)
      .where(and(
        eq(this.table.key, request.key),
        eq(this.table.ownerId, request.ownerId),
      ))
      .returning({ key: this.table.key });

    return deleted.length > 0;
  }

  /** Deletes a bounded claimed batch so multiple instances can cooperate. */
  public async prune(options: LockPruneOptions): Promise<number> {
    const limit = validatePruneLimit(options.limit ?? 1_000);
    const result = await this.database.execute(sql`
      WITH candidates AS (
        SELECT ${this.table.key}
        FROM ${this.table}
        WHERE ${this.table.expiresAt} <= statement_timestamp()
        ORDER BY ${this.table.expiresAt}, ${this.table.key}
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM ${this.table}
      USING candidates
      WHERE ${this.table.key} = candidates.key
      RETURNING ${this.table.key}
    `);

    return result.rows.length;
  }

  private expiration(ttlMs: number) {
    // statement_timestamp() is stable for the complete atomic statement and
    // avoids relying on clocks from individual application processes.
    return sql<Date>`statement_timestamp() + (${ttlMs} * interval '1 millisecond')`;
  }
}

function validatePruneLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("Lock prune limit must be a positive integer.");
  }

  return limit;
}

function validateUniqueRequests(
  requests: readonly LockAcquireRequest[],
): void {
  if (new Set(requests.map((request) => request.key)).size !== requests.length) {
    throw new TypeError("Lock batches require unique keys.");
  }
}

class BatchAcquisitionContendedError extends Error {}

class BatchExtensionLostError extends Error {}

function compareKeys(left: string, right: string): number {
  // Code-unit ordering is identical across processes and host locales.
  return left < right ? -1 : left > right ? 1 : 0;
}
