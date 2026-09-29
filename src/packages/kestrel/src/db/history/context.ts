import { sql } from "drizzle-orm";

import type { DatabaseManager } from "../database_manager.js";

export interface HistoryContext {
  readonly actor?: string;
  readonly reason?: string;
}

interface StoredHistoryContext extends Record<string, unknown> {
  readonly actor: string | null;
  readonly reason: string | null;
}

/**
 * Makes history metadata visible to database triggers for one transaction.
 * Nested calls restore their parent's metadata before returning.
 */
export function runWithHistoryContext<Result>(
  databaseManager: DatabaseManager,
  context: HistoryContext,
  operation: () => Promise<Result>,
): Promise<Result> {
  return databaseManager.transaction(async () => {
    const previous = await readHistoryContext(databaseManager);
    await writeHistoryContext(databaseManager, context);

    try {
      const result = await operation();
      await writeHistoryContext(databaseManager, previous);
      return result;
    } catch (error) {
      try {
        await writeHistoryContext(databaseManager, previous);
      } catch {
        // A failed SQL command aborts PostgreSQL transactions. Preserve the
        // original failure and let the owning transaction perform the reset.
      }
      throw error;
    }
  });
}

async function readHistoryContext(
  databaseManager: DatabaseManager,
): Promise<StoredHistoryContext> {
  const result = await databaseManager.database.execute<StoredHistoryContext>(
    sql`SELECT
      nullif(current_setting('kestrel.history.actor', true), '') AS actor,
      nullif(current_setting('kestrel.history.reason', true), '') AS reason`,
  );

  return result.rows[0] ?? { actor: null, reason: null };
}

async function writeHistoryContext(
  databaseManager: DatabaseManager,
  context: HistoryContext | StoredHistoryContext,
): Promise<void> {
  await databaseManager.database.execute(sql`SELECT
    set_config('kestrel.history.actor', ${context.actor ?? ""}, true),
    set_config('kestrel.history.reason', ${context.reason ?? ""}, true)`);
}
