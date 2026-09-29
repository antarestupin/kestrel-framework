import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import type { DatabaseConfig } from "./configuration.js";
import { databaseConfigBase } from "./configuration.js";
import { DatabaseManager } from "./database_manager.js";
import { type DatabaseClient, DatabaseProvider } from "./provider.js";

const databaseConfig: DatabaseConfig = {
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
};

class ExtendedDatabaseProvider extends DatabaseProvider<{ name: string }> {
  public extensionRegistered = false;

  protected override registerExtensions(): void {
    this.extensionRegistered = true;
  }
}

describe("DatabaseProvider", () => {
  it("uses security-conscious query observation defaults", () => {
    const parsed = databaseConfigBase.schema.parse({
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
    const client = app.container.resolve(
      dep<DatabaseClient>("databaseClient"),
    );

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

  it("closes an instantiated database client on disposal", async () => {
    const app = createTestApp();
    const client = app.container.resolve(
      dep<DatabaseClient>("databaseClient"),
    );
    const close = vi.spyOn(client, "close");

    await app.dispose();

    expect(close).toHaveBeenCalledOnce();
  });

  it("shares a manager inside one execution scope", async () => {
    const app = createTestApp();
    await app.start();
    const firstExecution = await app.createExecutionScope();
    const secondExecution = await app.createExecutionScope();
    const first = firstExecution.container.resolve(
      dep<DatabaseManager>("databaseManager"),
    );

    expect(firstExecution.container.resolve(
      dep<DatabaseManager>("databaseManager"),
    )).toBe(first);
    const second = secondExecution.container.resolve(
      dep<DatabaseManager>("databaseManager"),
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
  return new App({ name: "test" }).register(
    new DatabaseProvider(databaseConfig),
  );
}
