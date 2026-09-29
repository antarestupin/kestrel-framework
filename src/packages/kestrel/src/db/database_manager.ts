import { AsyncLocalStorage } from "node:async_hooks";

import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";

type TransactionDatabase = PgDatabase<
  NodePgQueryResultHKT,
  Record<string, unknown>
>;

type DatabaseTransaction = Parameters<
  Parameters<TransactionDatabase["transaction"]>[0]
>[0];

export type DatabaseExecutor = Pick<
  TransactionDatabase,
  "delete" | "execute" | "insert" | "select" | "update"
>;

export interface DatabaseManagerDependencies {
  database: TransactionDatabase;
}

/**
 * Selects the database executor active in the current asynchronous operation.
 *
 * The manager is scoped to one request or command, while AsyncLocalStorage
 * prevents parallel action branches in that scope from leaking transactions
 * into each other.
 */
export class DatabaseManager {
  private readonly transactions =
    new AsyncLocalStorage<DatabaseTransaction>();

  public constructor(
    private readonly dependencies: DatabaseManagerDependencies,
  ) {}

  /**
   * Returns the current transaction or the application database when idle.
   */
  public get database(): DatabaseExecutor {
    return this.transactions.getStore()
      ?? this.dependencies.database;
  }

  /**
   * Runs an operation atomically, joining an existing transaction when nested.
   */
  public transaction<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (this.transactions.getStore() !== undefined) {
      return operation();
    }

    return this.dependencies.database.transaction(
      (transaction) =>
        this.transactions.run(transaction, operation),
    );
  }
}
