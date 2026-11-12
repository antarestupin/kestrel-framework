import { EventEmitter } from "node:events";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import type {
  ClientBase,
  Pool,
  QueryResult,
} from "pg";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createPostgresTestPool } from "../testing/postgres.js";
import type {
  DatabaseQueryInstrumentation,
  DatabaseQueryInstrumentationEvent,
} from "./observations.js";
import {
  instrumentDrizzleDatabase,
  instrumentPostgresClient,
  instrumentPostgresPool,
} from "./query_instrumentation.js";

const successfulResult: QueryResult = {
  command: "SELECT",
  rowCount: 1,
  oid: 0,
  fields: [],
  rows: [{ id: 42 }],
};
const instrumentedUsers = pgTable("query_instrumentation_user", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

describe("PostgreSQL query instrumentation", () => {
  it("captures the application caller through a real Drizzle pool query", async () => {
    const pool = createPostgresTestPool();
    const events: DatabaseQueryInstrumentationEvent[] = [];
    const getInstrumentation = () => ({
      record: (event: DatabaseQueryInstrumentationEvent) => events.push(event),
    });

    instrumentPostgresPool(
      pool,
      { parameters: "omit", origin: "caller" },
      getInstrumentation,
    );
    const database = instrumentDrizzleDatabase(
      drizzle(pool),
      { parameters: "omit", origin: "caller" },
      getInstrumentation,
    );

    try {
      await executeDrizzleQuery(database);
      expect(events).toHaveLength(1);
      expect(events[0]?.data).toMatchObject({
        sql: expect.stringContaining("select 42"),
        origin: {
          function: expect.stringContaining("executeDrizzleQuery"),
          file: expect.stringContaining("query_instrumentation.test.ts"),
          line: expect.any(Number),
          column: expect.any(Number),
        },
      });
    } finally {
      await pool.end();
    }
  });

  it("captures transaction and relational-query callers without leaking driver stack frames", async () => {
    const pool = createPostgresTestPool();
    const events: DatabaseQueryInstrumentationEvent[] = [];
    const getInstrumentation = () => ({ record: (event: DatabaseQueryInstrumentationEvent) => events.push(event) });
    const config = { parameters: "include", origin: "stack" } as const;
    instrumentPostgresPool(pool, config, getInstrumentation);
    const database = instrumentDrizzleDatabase(
      drizzle(pool, { schema: { users: instrumentedUsers } }), config, getInstrumentation,
    );

    try {
      await database.transaction(async (transaction) => {
        // The table belongs to the transaction connection and disappears at commit.
        await transaction.execute(sql`create temporary table query_instrumentation_user (id integer primary key, name text not null) on commit drop`);
        await transaction.insert(instrumentedUsers).values({ id: 42, name: "Ada" });
        const users = transaction.query.users;
        expect(transaction.query.users).toBe(users);
        expect(await users.findFirst({ where: (table, { eq }) => eq(table.id, 42) })).toEqual({ id: 42, name: "Ada" });
      });

      const begin = events.find((event) => event.data.sql === "begin");
      const select = events.find((event) => event.data.sql.startsWith("select"));
      expect(begin?.data.origin?.file).toContain("query_instrumentation.test.ts");
      expect(select?.data).toMatchObject({ parameters: [42, 1], command: "SELECT", rowCount: 1 });
      const frames = select?.data.origin?.stack ?? [];
      expect(frames[0]).toContain("query_instrumentation.test.ts");
      expect(frames.every((frame) => !frame.includes("/node_modules/") && !frame.includes("node:internal"))).toBe(true);
      expect(events.at(-1)?.data.sql).toBe("commit");
    } finally {
      await pool.end();
    }
  });

  it("preserves the caller across the pool's asynchronous dispatch", async () => {
    const client = createClient(vi.fn(async () => successfulResult));
    const pool = createAsynchronousPool(client);
    const record = vi.fn<(event: DatabaseQueryInstrumentationEvent) => void>();

    instrumentPostgresPool(
      pool,
      { parameters: "omit", origin: "caller" },
      () => ({ record }),
    );
    // Drizzle transactions use clients emitted by this same pool event.
    pool.emit("connect", client);

    await pool.query("select 42");

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sql: "select 42",
        origin: expect.objectContaining({
          file: expect.stringContaining("query_instrumentation.test.ts"),
        }),
      }),
      outcome: "success",
    }));
  });

  it("records named prepared queries with parameters and result metadata", async () => {
    const query = vi.fn(async () => successfulResult);
    const client = createClient(query);
    const record = vi.fn<(event: DatabaseQueryInstrumentationEvent) => void>();

    instrumentPostgresClient(
      client,
      { parameters: "include", origin: "none" },
      () => ({ record }),
    );

    await client.query({
      name: "find-user",
      text: "select * from users where id = $1",
      values: [42],
    });

    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      data: {
        sql: "select * from users where id = $1",
        parameters: [42],
        statementName: "find-user",
        command: "SELECT",
        rowCount: 1,
      },
      durationMs: expect.any(Number),
      outcome: "success",
    });
  });

  it("keeps pg parameter precedence and converts observations without changing driver values", async () => {
    const query = vi.fn(async () => ({ ...successfulResult, rowCount: null }));
    const client = createClient(query);
    const record = vi.fn<(event: DatabaseQueryInstrumentationEvent) => void>();
    instrumentPostgresClient(client, { parameters: "include", origin: "none" }, () => ({ record }));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const date = new Date("2026-01-01T00:00:00.000Z");
    const values = [null, "text", true, 1.25, Infinity, 42n, date, { nested: 3n }, cyclic, undefined];
    const queryConfig = { text: "select $1", values: ["unused"], name: "mixed" };

    // The explicit overload wins over QueryConfig.values, even for driver-specific values.
    await client.query(queryConfig, values);
    expect(query).toHaveBeenCalledExactlyOnceWith(queryConfig, values);
    expect(record).toHaveBeenNthCalledWith(1, {
      data: {
        sql: "select $1", statementName: "mixed", command: "SELECT",
        parameters: [null, "text", true, 1.25, "Infinity", "42", date.toISOString(), { nested: "3" }, "[object Object]", "undefined"],
      },
      durationMs: expect.any(Number), outcome: "success",
    });
    await client.query({ text: "select 42" });
    expect(record.mock.calls[1]?.[0].data).toEqual({ sql: "select 42", command: "SELECT" });
  });

  it("wraps each pool and client once and preserves non-promise driver return values", async () => {
    const handle = new EventEmitter();
    const query = vi.fn(() => handle);
    const client = createClient(query);
    const pool = createAsynchronousPool(client);
    const record = vi.fn();
    const config = { parameters: "omit", origin: "none" } as const;
    const sink = () => ({ record });

    instrumentPostgresPool(pool, config, sink);
    const poolQuery = pool.query;
    instrumentPostgresPool(pool, config, sink);
    expect(pool.query).toBe(poolQuery);
    expect(pool.listenerCount("connect")).toBe(1);
    pool.emit("connect", client);
    const clientQuery = client.query;
    pool.emit("connect", client);
    expect(client.query).toBe(clientQuery);

    // pg can return an event handle for Query objects instead of a promise.
    const rawQuery = Object.assign(new EventEmitter(), { submit: vi.fn() });
    expect(client.query(rawQuery)).toBe(handle);
    expect(client.query("select 42")).toBe(handle);
    expect(query.mock.calls).toEqual([[rawQuery], ["select 42"]]);
    expect(record).not.toHaveBeenCalled();
  });

  it("records synchronous driver errors and callback failures without replacing either error", async () => {
    const failure = Object.assign(new Error("invalid driver input"), { code: 42 });
    const callbackFailure = Object.assign(new Error("database unavailable"), { code: "08006" });
    const client = createClient(vi.fn<(...args: unknown[]) => unknown>()
      .mockImplementationOnce(() => { throw failure; })
      .mockImplementationOnce((...args) => Reflect.apply(args.at(-1) as Function, undefined, [callbackFailure])));
    const record = vi.fn<(event: DatabaseQueryInstrumentationEvent) => void>();
    instrumentPostgresClient(client, { parameters: "omit", origin: "none" }, () => ({ record }));

    expect(() => client.query("select 1")).toThrow(failure);
    const callback = vi.fn();
    client.query("select 2", [], callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(callbackFailure, undefined);
    expect(record.mock.calls.map(([event]) => ({ data: event.data, outcome: event.outcome }))).toEqual([
      { data: { sql: "select 1" }, outcome: "failure" },
      { data: { sql: "select 2", errorCode: "08006" }, outcome: "failure" },
    ]);
  });

  it("omits parameters and records PostgreSQL failure codes", async () => {
    const failure = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    const client = createClient(vi.fn(async () => Promise.reject(failure)));
    const record = vi.fn<(event: DatabaseQueryInstrumentationEvent) => void>();

    instrumentPostgresClient(
      client,
      { parameters: "omit", origin: "none" },
      () => ({ record }),
    );

    await expect(client.query(
      "insert into users (email) values ($1)",
      ["private@example.com"],
    )).rejects.toBe(failure);

    expect(record).toHaveBeenCalledWith({
      data: {
        sql: "insert into users (email) values ($1)",
        errorCode: "23505",
      },
      durationMs: expect.any(Number),
      outcome: "failure",
    });
  });

  it("supports callback queries and captures their application caller", async () => {
    const query = vi.fn((...arguments_: unknown[]) => {
      const callback = arguments_.at(-1) as (
        error: Error | null,
        result: QueryResult,
      ) => void;

      // node-postgres reports a successful callback with a null error.
      callback(null, successfulResult);
    });
    const client = createClient(query);
    const events: DatabaseQueryInstrumentationEvent[] = [];

    instrumentPostgresClient(
      client,
      { parameters: "omit", origin: "caller" },
      () => ({ record: (event) => events.push(event) }),
    );

    await new Promise<void>((resolve, reject) => {
      client.query("select 42", (error) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe("success");
    expect(events[0]?.data.origin).toMatchObject({
      file: expect.stringContaining("query_instrumentation.test.ts"),
      line: expect.any(Number),
      column: expect.any(Number),
    });
  });

  it("does not instrument queries without an active execution sink", async () => {
    const query = vi.fn(async () => successfulResult);
    const client = createClient(query);

    instrumentPostgresClient(
      client,
      { parameters: "include", origin: "stack" },
      () => undefined,
    );

    await client.query("select $1::integer", [42]);

    expect(query).toHaveBeenCalledOnce();
  });

  it("does not let a failing instrumentation sink change query results", async () => {
    const client = createClient(vi.fn(async () => successfulResult));
    const instrumentation: DatabaseQueryInstrumentation = {
      record: () => {
        throw new Error("instrumentation failed");
      },
    };

    instrumentPostgresClient(
      client,
      { parameters: "omit", origin: "none" },
      () => instrumentation,
    );

    await expect(client.query("select 42")).resolves.toBe(successfulResult);
  });
});

/** Creates the minimal mutable client surface required by the wrapper. */
function createClient(query: (...arguments_: unknown[]) => unknown): ClientBase {
  return { query } as unknown as ClientBase;
}

/** Reproduces pg-pool dispatching to a physical client in a later microtask. */
function createAsynchronousPool(client: ClientBase): Pool {
  const pool = new EventEmitter() as Pool;

  pool.query = ((...arguments_: unknown[]) =>
    Promise.resolve().then(() => {
      const queryClient = client.query.bind(client) as (
        ...queryArguments: unknown[]
      ) => unknown;

      return queryClient(...arguments_);
    })) as Pool["query"];

  return pool;
}

/** Keeps a recognizable application frame above the real Drizzle call. */
async function executeDrizzleQuery(
  database: ReturnType<typeof drizzle>,
): Promise<void> {
  await database
    .select({ value: sql<number>`42` })
    .from(sql`(select 1) as source`);
}
