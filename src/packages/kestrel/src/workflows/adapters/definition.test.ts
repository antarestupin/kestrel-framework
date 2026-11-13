import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";

import { dep } from "../../di/index.js";
import type { AdapterDependencyResolver } from "../../di/adapter.js";
import { MemoryWorkflowAdapter, memoryWorkflows } from "./memory/index.js";
import type { PostgresWorkflowDatabase } from "./postgres/index.js";

describe("built-in workflow adapter definitions", () => {
  it("creates memory adapters with the declared transport and without infrastructure", () => {
    const unused = vi.fn((): never => { throw new Error("Unexpected adapter dependency."); });
    const mode = { activityDispatchMode: "outbox" } as const;
    const definition = memoryWorkflows(mode);
    expect(definition.capabilities).toEqual(mode);
    const adapter = definition.create(unused, mode);
    expect(adapter).toBeInstanceOf(MemoryWorkflowAdapter);
    expect(adapter.activityDispatchMode).toBe("outbox");
    expect(memoryWorkflows().capabilities).toEqual({ activityDispatchMode: "embedded" });
    expect(unused).not.toHaveBeenCalled();
  });

  it("resolves the declared database only during PostgreSQL creation", async () => {
    const { PostgresWorkflowAdapter, postgresWorkflows } = await import("./postgres/index.js");
    const dependency = dep<PostgresWorkflowDatabase>("workflowDatabase");
    const database = drizzle.mock();
    const resolve = vi.fn((descriptor: unknown) => {
      expect(descriptor).toBe(dependency);
      return database;
    });
    const mode = { activityDispatchMode: "outbox" } as const;
    const definition = postgresWorkflows(dependency, mode);
    expect(definition.capabilities).toEqual(mode);
    expect(resolve).not.toHaveBeenCalled();

    // The real provider supplies the generic resolver with a registered database.
    const adapter = definition.create(resolve as AdapterDependencyResolver, mode);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(dependency);
    expect(adapter).toBeInstanceOf(PostgresWorkflowAdapter);
    expect(adapter.activityDispatchMode).toBe("outbox");
    expect(postgresWorkflows(dependency).capabilities).toEqual({ activityDispatchMode: "embedded" });
  });

  it("coerces a positive integer terminal poll interval and rejects invalid inputs", async () => {
    vi.resetModules();
    const { postgresWorkflowsConfigBase } = await import("./postgres/configuration.js");
    const { schema } = postgresWorkflowsConfigBase;
    expect(schema.parse({})).toEqual({ terminalPollIntervalMs: 25 });
    for (const input of ["17", 17]) {
      expect(schema.parse({ terminalPollIntervalMs: input })).toEqual({ terminalPollIntervalMs: 17 });
    }
    for (const input of [0, -1, 1.5, Number.NaN, "invalid", true, null]) {
      expect(schema.safeParse({ terminalPollIntervalMs: input }).success).toBe(false);
    }
  });
});
