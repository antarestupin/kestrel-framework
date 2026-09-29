import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DatabaseManager,
  type DatabaseManagerDependencies,
} from "./database_manager.js";

describe("DatabaseManager", () => {
  it("uses the transaction executor inside the callback", async () => {
    const rootDatabase = createDatabaseStub();
    const transactionDatabase = {};
    const transaction = vi.fn(
      async (
        operation: (database: never) => Promise<unknown>,
      ) => operation(transactionDatabase as never),
    );
    rootDatabase.transaction = transaction;
    const manager = new DatabaseManager({
      database: asTransactionDatabase(rootDatabase),
    });

    expect(manager.database).toBe(rootDatabase);

    await manager.transaction(async () => {
      expect(manager.database).toBe(transactionDatabase);
    });

    expect(manager.database).toBe(rootDatabase);
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("joins an ambient transaction when callbacks are nested", async () => {
    const rootDatabase = createDatabaseStub();
    const transactionDatabase = {};
    const transaction = vi.fn(
      async (
        operation: (database: never) => Promise<unknown>,
      ) => operation(transactionDatabase as never),
    );
    rootDatabase.transaction = transaction;
    const manager = new DatabaseManager({
      database: asTransactionDatabase(rootDatabase),
    });

    await manager.transaction(async () => {
      await manager.transaction(async () => {
        expect(manager.database).toBe(transactionDatabase);
      });
    });

    expect(transaction).toHaveBeenCalledOnce();
  });

  it("does not leak a transaction into a parallel asynchronous branch", async () => {
    const rootDatabase = createDatabaseStub();
    const transactionDatabase = {};
    const transaction = vi.fn(
      async (
        operation: (database: never) => Promise<unknown>,
      ) => operation(transactionDatabase as never),
    );
    rootDatabase.transaction = transaction;
    const manager = new DatabaseManager({
      database: asTransactionDatabase(rootDatabase),
    });

    await Promise.all([
      manager.transaction(async () => {
        await Promise.resolve();
        expect(manager.database).toBe(transactionDatabase);
      }),
      Promise.resolve().then(() => {
        expect(manager.database).toBe(rootDatabase);
      }),
    ]);
  });
});

/**
 * Creates the minimum runtime shape needed by the manager unit tests.
 */
function createDatabaseStub(): Record<string, unknown> {
  return {};
}

/**
 * Restricts the test cast to the mocked transaction boundary.
 */
function asTransactionDatabase(
  database: Record<string, unknown>,
): DatabaseManagerDependencies["database"] {
  return database as unknown as DatabaseManagerDependencies["database"];
}
