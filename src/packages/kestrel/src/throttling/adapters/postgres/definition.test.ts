import { expect, it, vi } from "vitest";

import { dep } from "../../../di/index.js";
import { throttlingConfigBase } from "../../configuration.js";
import type { PostgresRateLimitDatabase } from "./adapter.js";
import { postgresThrottling } from "./definition.js";

it("resolves the requested PostgreSQL dependency and closes only the composed adapter", async () => {
  const dependency = dep<PostgresRateLimitDatabase>("quotaDatabase");
  const execute = vi.fn().mockResolvedValue({ rows: [{ key: "quota", admitted: true, remaining: 4 }] });
  const database = { execute, close: vi.fn() };
  const resolve = vi.fn().mockReturnValue(database);
  const definition = postgresThrottling(dependency);
  const config = throttlingConfigBase.schema.parse({ namespace: "test" });
  const adapter = definition.create(resolve, { config });
  const request = { key: "quota", limit: 5, periodMs: 1_000, burst: 5, cost: 1 };

  try {
    expect(resolve).toHaveBeenCalledExactlyOnceWith(dependency);
    expect(definition.capabilities.prune).toBe(true);
    await expect(adapter.reserve(request)).resolves.toEqual({ admitted: true, remaining: 4, source: "authoritative" });
  } finally {
    await definition.dispose?.(adapter);
  }
  // The factory owns the lease coordinator, while PostgreSQL belongs to its provider.
  await expect(adapter.reserve(request)).rejects.toMatchObject({
    name: "ThrottlingBackendUnavailableError", cause: expect.objectContaining({ message: "The leased throttling adapter is closed." }),
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(database.close).not.toHaveBeenCalled();
});
