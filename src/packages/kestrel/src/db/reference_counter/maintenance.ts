import { setTimeout as pause } from "node:timers/promises";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { ReferenceCounterDefinition } from "./types.js";
import { quoteIdentifier as quote, tableIdentifier } from "./sql.js";

/** Unknown identifiers are operator input errors, safe to display without debug mode. */
class UnknownReferenceCounterError extends Error {
  public toCliError() { return { exitCode: 2, message: this.message }; }
}

export interface ReferenceCounterProgress {
  readonly id: string;
  readonly processed: number;
  readonly updated: number;
  /** Text representation of the last committed target key, usable as --after. */
  readonly cursor: string | undefined;
}
export interface ReferenceCounterRebuildOptions {
  readonly batchSize?: number;
  readonly pauseMs?: number;
  readonly after?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ReferenceCounterProgress) => void | Promise<void>;
}
export interface ReferenceCounterRebuildResult extends ReferenceCounterProgress {
  readonly completed: boolean;
}

/** Owns independent READ COMMITTED batches, never joining an ambient transaction. */
export class ReferenceCounterMaintenance {
  public constructor(
    private readonly database: NodePgDatabase<any>,
    private readonly definitions: readonly ReferenceCounterDefinition[],
  ) {}

  public async rebuild(id: string, options: ReferenceCounterRebuildOptions = {}): Promise<ReferenceCounterRebuildResult> {
    const definition = this.definitions.find((item) => item.id === id);
    if (definition === undefined) throw new UnknownReferenceCounterError(`Unknown reference counter "${id}".`);
    const batchSize = options.batchSize ?? 100;
    const pauseMs = options.pauseMs ?? 50;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000
      || !Number.isSafeInteger(pauseMs) || pauseMs < 0 || pauseMs > 60_000) {
      throw new TypeError("Counter rebuild requires batchSize 1..10000 and pauseMs 0..60000.");
    }
    let progress: ReferenceCounterProgress = { id, processed: 0, updated: 0, cursor: options.after };
    while (!options.signal?.aborted) {
      const batch = await this.rebuildBatch(definition, batchSize, progress.cursor);
      if (batch.processed === 0) return { ...progress, completed: true };
      progress = { id, processed: progress.processed + batch.processed, updated: progress.updated + batch.updated, cursor: batch.cursor };
      // Publish only committed progress, even if cancellation arrived mid-batch.
      await options.onProgress?.(progress);
      if (options.signal?.aborted) break;
      if (batch.processed < batchSize) return { ...progress, completed: true };
      if (pauseMs > 0) {
        try { await pause(pauseMs, undefined, options.signal === undefined ? {} : { signal: options.signal }); }
        catch (error) { if (!options.signal?.aborted) throw error; }
      }
    }
    return { ...progress, completed: false };
  }

  private async rebuildBatch(definition: ReferenceCounterDefinition, batchSize: number, after: string | undefined) {
    const target = sql.raw(tableIdentifier(definition.target.table));
    const key = sql.raw(quote(definition.target.name));
    const counter = sql.raw(quote(definition.counter.name));
    const source = sql.raw(tableIdentifier(definition.source));
    const reference = sql.raw(quote(definition.reference.name));
    return this.database.transaction(async (transaction) => {
      // Count in a separate command after locking: READ COMMITTED then sees
      // writers that committed while this batch was waiting for its locks.
      const selected = await transaction.execute<{ cursor: string }>(sql`
        SELECT ${key}::text AS cursor FROM ${target}
        ${after === undefined ? sql`` : sql`WHERE ${key} > ${after}`}
        ORDER BY ${key} LIMIT ${batchSize} FOR NO KEY UPDATE
      `);
      const cursors = selected.rows.map((row) => row.cursor);
      if (cursors.length === 0) return { processed: 0, updated: 0, cursor: after };
      const values = sql.join(cursors.map((cursor) => sql`${cursor}`), sql`, `);
      const updated = await transaction.execute(sql`
        WITH counts AS (
          SELECT parent.${key} AS target_key,
            (SELECT count(*) FROM ${source} AS source
             WHERE source.${reference} = parent.${key}
               AND (${sql.raw(definition.predicates.source)})) AS value
          FROM ${target} AS parent WHERE parent.${key} IN (${values})
        )
        UPDATE ${target} AS destination SET ${counter} = counts.value
        FROM counts WHERE destination.${key} = counts.target_key
          AND destination.${counter} IS DISTINCT FROM counts.value
      `);
      return { processed: cursors.length, updated: updated.rowCount ?? 0, cursor: cursors.at(-1)! };
    }, { isolationLevel: "read committed" });
  }
}
