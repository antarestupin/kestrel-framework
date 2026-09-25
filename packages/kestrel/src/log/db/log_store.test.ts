import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DevLogStore,
  type DevLogDatabase,
} from "./log_store.js";

// The store only needs Drizzle's fluent query surface for this unit test.
const database = (() => {
  const limit = vi.fn(async () => []);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn((_condition: SQL) => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  return { from, limit, orderBy, select, where };
})();

describe("development log store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters execution logs through their structured payload", async () => {
    const store = new DevLogStore(database as unknown as DevLogDatabase);

    await store.listByExecution("execution-1");

    const condition = database.where.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(condition);

    expect(query.sql).toContain(`"dev"."log"."payload"->>'executionId' = $1`);
    expect(query.params).toEqual(["execution-1"]);
    expect(database.orderBy).toHaveBeenCalledOnce();
  });

  it("loads several correlated execution logs through one query", async () => {
    const store = new DevLogStore(database as unknown as DevLogDatabase);

    await store.listByExecutions(["task-1:1", "task-2:1"]);

    const condition = database.where.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(condition);

    expect(query.sql).toContain(`"dev"."log"."payload"->>'executionId' in ($1, $2)`);
    expect(query.params).toEqual(["task-1:1", "task-2:1"]);
    expect(database.orderBy).toHaveBeenCalledOnce();
  });

  it("filters the log page by a canonical workload binding", async () => {
    const store = new DevLogStore(database as unknown as DevLogDatabase);

    await store.list({ workload: "workers" });

    const condition = database.where.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(condition);

    expect(query.sql).toContain(`"dev"."log"."payload"->>'workload' = $1`);
    expect(query.params).toEqual(["workers"]);
  });

  it("treats missing and unsupported workload bindings as system logs", async () => {
    const store = new DevLogStore(database as unknown as DevLogDatabase);

    await store.list({ workload: "system" });

    const condition = database.where.mock.calls[0]?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(condition);

    expect(query.sql).toContain(`"dev"."log"."payload"->>'workload' is null`);
    expect(query.sql).toContain(`"dev"."log"."payload"->>'workload' not in`);
    expect(query.params).toEqual([
      "http",
      "scheduled-tasks",
      "workers",
      "workflows",
    ]);
  });
});
