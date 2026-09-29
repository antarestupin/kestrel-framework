import { EventEmitter } from "node:events";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
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
    await pool.end();
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
