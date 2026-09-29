import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { LocalDatabaseMaintenance } from "./database_maintenance.js";

describe("LocalDatabaseMaintenance", () => {
  it("rejects maintenance outside the local environment", async () => {
    const maintenance = new LocalDatabaseMaintenance({
      database: {} as never,
      environment: "prod",
      pool: { query: vi.fn() } as never,
    }, {
      migration: {
        migrationsFolder: "migrations",
      },
      reset: {
        schemas: [],
      },
      seed: { steps: [] },
    });

    await expect(maintenance.seed()).rejects.toThrow(
      "Database maintenance is only allowed in the local environment.",
    );
    await expect(maintenance.reset()).rejects.toThrow(
      "Database maintenance is only allowed in the local environment.",
    );
    await expect(maintenance.resetAndSeed()).rejects.toThrow(
      "Database maintenance is only allowed in the local environment.",
    );
  });

  it("changes schemas without application-specific lifecycle hooks", async () => {
    const query = vi.fn(async () => {
      throw new Error("Reset stopped for test.");
    });
    const maintenance = new LocalDatabaseMaintenance({
      database: {} as never,
      environment: "local",
      pool: { query } as never,
    }, {
      migration: {
        migrationsFolder: "migrations",
      },
      reset: {
        schemas: ["public"],
      },
      seed: { steps: [] },
    });

    await expect(maintenance.reset()).rejects.toThrow(
      "Reset stopped for test.",
    );
    expect(query).toHaveBeenCalledOnce();
  });
});
