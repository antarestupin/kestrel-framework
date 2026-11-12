import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import {
  Pool,
  type ClientBase,
  type QueryResult,
} from "pg";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createPostgresTestConfig, createPostgresTestPool } from "../testing/postgres.js";
import type {
  DatabaseQueryInstrumentation,
  DatabaseQueryInstrumentationEvent,
} from "./observations.js";
import { PostgresPoolRuntime } from "./pool_runtime.js";
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
    let observing = true;
    const getInstrumentation = () => observing
      ? { record: (event: DatabaseQueryInstrumentationEvent) => events.push(event) }
      : undefined;
    const config = { parameters: "include", origin: "stack" } as const;
    instrumentPostgresPool(pool, config, getInstrumentation);
    const database = instrumentDrizzleDatabase(
      drizzle(pool, { schema: { users: instrumentedUsers } }), config, getInstrumentation,
    );

    try {
      expect(database.$client).toBe(pool);
      await database.transaction(async (transaction) => {
        // The table belongs to the transaction connection and disappears at commit.
        await transaction.execute(sql`create temporary table query_instrumentation_user (id integer primary key, name text not null) on commit drop`);
        await transaction.insert(instrumentedUsers).values({ id: 42, name: "Ada" });
        const users = transaction.query.users;
        expect(transaction.query.users).toBe(users);
        expect(await users.findFirst({ where: (table, { eq }) => eq(table.id, 42) })).toEqual({ id: 42, name: "Ada" });
        expect(users.findMany().toSQL().sql).toContain('"query_instrumentation_user"');

        // The same wrapped transaction and relation remain usable outside observation.
        const observedCount = events.length;
        observing = false;
        try {
          expect(await users.findFirst()).toEqual({ id: 42, name: "Ada" });
          expect(await transaction.execute(sql`select 42 as id`)).toMatchObject({ rows: [{ id: 42 }] });
          expect(await pool.query("select 42 as id")).toMatchObject({ rows: [{ id: 42 }] });
        } finally {
          observing = true;
        }
        expect(events).toHaveLength(observedCount);
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

  it("attributes a queued pool query to the requesting execution, even when another execution releases the connection", async () => {
    const config = { ...createPostgresTestConfig(), max: 1 };
    const pool = new Pool(config);
    const runtime = new PostgresPoolRuntime(pool, config.resourcePolicy);
    const scope = new AsyncLocalStorage<DatabaseQueryInstrumentation>();
    const record = vi.fn<DatabaseQueryInstrumentation["record"]>();
    const recordReleaser = vi.fn<DatabaseQueryInstrumentation["record"]>();
    instrumentPostgresPool(pool, config.queryObservability, () => scope.getStore());

    try {
      const lease = await pool.connect();
      const result = scope.run({ record }, function queryInWaitingExecution() {
        return pool.query("select 42 as id");
      });
      const waiting = pool.waitingCount;
      // pg-pool resumes a queued callback from the unrelated release call.
      scope.run({ record: recordReleaser }, () => lease.release());

      await expect(result).resolves.toMatchObject({ rows: [{ id: 42 }] });
      expect(waiting).toBe(1);
      expect(recordReleaser).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        outcome: "success",
        data: expect.objectContaining({
          sql: "select 42 as id",
          origin: expect.objectContaining({
            function: expect.stringContaining("queryInWaitingExecution"),
          }),
        }),
      }));
    } finally {
      await runtime.close();
    }
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

  it.each([
    { name: "the stack is unavailable", format: () => undefined },
    {
      name: "every frame belongs to dependencies or Node",
      format: () => [
        "Error",
        "    at query (/app/node_modules/pg/lib/client.js:42:10)",
        "    at process.processTicksAndRejections (node:internal/process/task_queues:99:5)",
      ].join("\n"),
    },
    {
      name: "a custom formatter returns structured frames",
      format: (_error: Error, frames: NodeJS.CallSite[]) => frames,
    },
    {
      name: "a custom formatter throws",
      format: () => { throw new Error("stack formatter failed"); },
    },
  ])("executes and records a query without an origin when $name", async ({ format }) => {
    const query = vi.fn(async () => successfulResult);
    const client = createClient(query);
    const record = vi.fn<DatabaseQueryInstrumentation["record"]>();
    instrumentPostgresClient(client, { parameters: "omit", origin: "stack" }, () => ({ record }));

    const result = withStackFormatter(format, () => client.query("select 42"));

    await expect(result).resolves.toBe(successfulResult);
    expect(query).toHaveBeenCalledExactlyOnceWith("select 42");
    expect(record).toHaveBeenCalledExactlyOnceWith({
      data: { sql: "select 42", command: "SELECT", rowCount: 1 },
      durationMs: expect.any(Number),
      outcome: "success",
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

/** Changes V8 stack formatting only for the synchronous query invocation. */
function withStackFormatter<Value>(
  format: ErrorConstructor["prepareStackTrace"],
  run: () => Value,
): Value {
  const previous = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  Error.prepareStackTrace = format;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(Error, "prepareStackTrace");
    } else {
      Object.defineProperty(Error, "prepareStackTrace", previous);
    }
  }
}

/** Keeps a recognizable application frame above the real Drizzle call. */
async function executeDrizzleQuery(
  database: ReturnType<typeof drizzle>,
): Promise<void> {
  await database
    .select({ value: sql<number>`42` })
    .from(sql`(select 1) as source`);
}
