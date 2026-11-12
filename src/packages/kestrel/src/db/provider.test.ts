import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import type { Pool } from "pg";

import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import { AsyncLocalObserverContext, type Observer } from "../observability/index.js";
import type { PostgresDrizzleConfig } from "./configuration.js";
import { postgresDrizzleConfigBase } from "./configuration.js";
import { PostgresDrizzleManager } from "./database_manager.js";
import { type PostgresDrizzleClient, PostgresDrizzleProvider } from "./provider.js";

const databaseConfig: PostgresDrizzleConfig = postgresDrizzleConfigBase.schema.parse({
  host: "localhost",
  port: 5_432,
  user: "postgres",
  password: "postgres",
  database: "provider_test",
  ssl: false,
  queryObservability: {
    parameters: "omit",
    origin: "caller",
  },
});

class ExtendedDatabaseProvider extends PostgresDrizzleProvider<{ name: string }> {
  public extensionRegistered = false;

  protected override registerExtensions(): void {
    this.extensionRegistered = true;
  }
}

describe("PostgresDrizzleProvider", () => {
  it("instruments connections with only the observer active for the query", async () => {
    const sample = pgTable("sample", { id: text("id").primaryKey() });
    const context = new AsyncLocalObserverContext();
    const record = vi.fn<Observer["record"]>();
    const app = new App({});
    app.container.registerValue("observerContext", context);
    app.register(new PostgresDrizzleProvider(databaseConfig, { schema: { sample } }));

    try {
      const { database, pool } = app.container.resolve(
        dep<PostgresDrizzleClient<NodePgDatabase<{ sample: typeof sample }>>>("databaseClient"),
      );
      expect(database.query.sample).toBeDefined();
      expect(pool.totalCount).toBe(0);

      // Exercise the provider's pool connection hook with a controlled driver query.
      const result = { command: "SELECT", rowCount: 1, rows: [{ value: "secret" }] };
      const query = vi.fn(async (_text: string, _params: string[]) => result);
      const connection = Object.assign(new EventEmitter(), { query });
      pool.emit("connect", connection);

      await expect(connection.query("SELECT $1::text AS value", ["secret"])).resolves.toBe(result);
      expect(record).not.toHaveBeenCalled();
      await expect(context.run({ record }, () => connection.query("SELECT $1::text AS value", ["secret"])))
        .resolves.toBe(result);
      expect(record).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ name: "database.query", category: "database" }),
        expect.objectContaining({ sql: "SELECT $1::text AS value", command: "SELECT", rowCount: 1 }),
        expect.objectContaining({ outcome: "success" }),
      );
      expect(record.mock.calls[0]?.[1]).not.toHaveProperty("parameters");
      await connection.query("SELECT $1::text AS value", ["secret"]);
      expect(record).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalledTimes(3);
      connection.emit("end");
    } finally {
      await app.dispose();
    }
  });

  it("constructs a schema-aware facade lazily without an application subclass", async () => {
    const sample = pgTable("sample", { id: text("id").primaryKey() });
    const createDatabase = vi.fn((pool: Pool) => drizzle(pool, { schema: { sample } }));
    const app = new App({}).register(
      new PostgresDrizzleProvider(databaseConfig, { createDatabase }),
    );
    try {
      expect(createDatabase).not.toHaveBeenCalled();
      const client = app.container.resolve(
        dep<PostgresDrizzleClient<ReturnType<typeof createDatabase>>>("databaseClient"),
      );
      expect(createDatabase).toHaveBeenCalledExactlyOnceWith(client.pool);
      // The custom facade remains available through both infrastructure registrations.
      expect(client.database.query.sample).toBeDefined();
      expect(app.container.resolve(dep("database"))).toBe(client.database);
    } finally {
      await app.dispose();
    }
  });

  it("uses security-conscious query observation defaults", () => {
    const parsed = postgresDrizzleConfigBase.schema.parse({
      host: "localhost",
      user: "postgres",
      password: "postgres",
      database: "provider_test",
    });

    expect(parsed.queryObservability).toEqual({
      parameters: "omit",
      origin: "caller",
    });
  });

  it("registers lazy database infrastructure from dedicated configuration", async () => {
    const app = createTestApp();
    const client = app.container.resolve(dep<PostgresDrizzleClient>("databaseClient"));

    expect(app.container.resolve(dep("database"))).toBe(client.database);
    expect(client.pool.options).toMatchObject({
      host: databaseConfig.host,
      port: databaseConfig.port,
      user: databaseConfig.user,
      database: databaseConfig.database,
      ssl: databaseConfig.ssl,
    });
    // node-postgres deliberately makes pool passwords non-enumerable.
    expect(client.pool.options.password).toBe(databaseConfig.password);

    await app.dispose();
  });

  it("forwards native settings and installs a boundary before facade construction", async () => {
    const events = vi.fn();
    const getTypeParser = () => (value: string) => value;
    const config = postgresDrizzleConfigBase.schema.parse({
      ...databaseConfig, max: 3, connectionTimeoutMillis: 200,
      types: { getTypeParser }, ssl: { ca: "private CA" },
    });
    const app = new App({}).register(new PostgresDrizzleProvider(config, {
      onPoolEvent: events,
      createDatabase: (pool) => {
        // The actual provider must contain idle-client errors even before instrumentation.
        pool.emit("error", Object.assign(new Error("secret connection details"), { code: "ECONNRESET" }));
        return drizzle(pool);
      },
    }));
    try {
      const client = app.container.resolve(dep<PostgresDrizzleClient>("databaseClient"));
      expect(client.snapshot().state).toBe("degraded");
      expect(client.pool.options).toMatchObject({
        max: 3, connectionTimeoutMillis: 200, types: { getTypeParser },
        ssl: { ca: "private CA", rejectUnauthorized: true },
      });
      expect(client.pool.options).not.toHaveProperty("resourcePolicy");
      expect(client.pool.options).not.toHaveProperty("queryObservability");
      expect(JSON.stringify(events.mock.calls)).not.toContain("secret");
    } finally { await app.dispose(); }
  });

  it("closes an instantiated database client on disposal", async () => {
    const app = createTestApp();
    const client = app.container.resolve(dep<PostgresDrizzleClient>("databaseClient"));
    const close = vi.spyOn(client, "close");

    await app.dispose();

    expect(close).toHaveBeenCalledOnce();
  });

  it("shares a manager inside one execution scope", async () => {
    const app = createTestApp();
    await app.start();
    const firstExecution = await app.createExecutionScope();
    const secondExecution = await app.createExecutionScope();
    const first = firstExecution.container.resolve(dep<PostgresDrizzleManager>("databaseManager"));

    expect(firstExecution.container.resolve(dep<PostgresDrizzleManager>("databaseManager"))).toBe(
      first,
    );
    const second = secondExecution.container.resolve(
      dep<PostgresDrizzleManager>("databaseManager"),
    );

    // Awilix exposes proxy-backed scoped values, so identity is checked
    // without asking the assertion formatter to inspect their properties.
    expect(Object.is(second, first)).toBe(false);

    await firstExecution.dispose();
    await secondExecution.dispose();
    await app.dispose();
  });

  it("invokes protected application extension registration", async () => {
    const app = new App({ name: "test" });
    const provider = new ExtendedDatabaseProvider(databaseConfig);

    app.register(provider);

    expect(provider.extensionRegistered).toBe(true);
    await app.dispose();
  });
});

function createTestApp(): App<{ name: string }> {
  return new App({ name: "test" }).register(new PostgresDrizzleProvider(databaseConfig));
}
