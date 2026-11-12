import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Pool } from "pg";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createDevLogStore,
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

it("bounds pages, combines filters, preserves cursors and skips empty execution batches", async () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const query = vi.fn(async (_query: { text: string }, _values: readonly unknown[]): Promise<{ rows: unknown[][] }> => ({ rows: [] }));
  const store = createDevLogStore({ query } as unknown as Pool);

  await expect(store.listByExecutions([])).resolves.toEqual([]);
  expect(query).not.toHaveBeenCalled();
  query.mockResolvedValueOnce({ rows: [
    ["8", timestamp, 40, "visible", null, { workload: "workers" }, timestamp],
    ["7", timestamp, 40, "next", null, { workload: "workers" }, timestamp],
  ] });
  await expect(store.list({ before: 9, level: 40, workload: "workers", limit: 0 })).resolves.toMatchObject({
    items: [{ id: 8, loggedAt: new Date(timestamp), level: 40, message: "visible" }], nextBefore: 8,
  });
  expect(query.mock.calls[0]?.[0].text).toContain('"dev"."log"."id" < $1');
  expect(query.mock.calls[0]?.[1]).toEqual([9, 40, "workers", 2]);
  await expect(store.list({ limit: 500 })).resolves.toEqual({ items: [], nextBefore: null });
  await expect(store.list()).resolves.toEqual({ items: [], nextBefore: null });
  expect(query.mock.calls[1]?.[1]).toEqual([251]);
  expect(query.mock.calls[2]?.[1]).toEqual([101]);
  await store.clear();
  expect(query.mock.calls[3]?.[0].text).toBe('delete from "dev"."log"');
});
