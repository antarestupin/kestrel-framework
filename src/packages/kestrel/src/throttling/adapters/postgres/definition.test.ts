import { expect, it, vi } from "vitest";

import { dep } from "../../../di/index.js";
import { throttlingConfigBase } from "../../configuration.js";
import type { ThrottlingInstrumentationEvent } from "../../observations.js";
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

it("forwards lease events through the PostgreSQL factory instrumentation", async () => {
  const execute = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ key: "quota", conflict: false, available: 1, outstanding: 0 }] })
    .mockResolvedValueOnce({ rows: [{ key: "quota", mode: "exact", remaining: 0 }] });
  const database = { transaction: (work: (transaction: { execute: typeof execute }) => unknown) => work({ execute }) };
  const definition = postgresThrottling(dep<PostgresRateLimitDatabase>("quotaDatabase"));
  const config = throttlingConfigBase.schema.parse({ namespace: "test" });
  const record = vi.fn<(event: ThrottlingInstrumentationEvent) => void>();
  const adapter = definition.create(vi.fn().mockReturnValue(database), { config, instrumentation: { record } });

  try {
    // Scarce capacity forces an exact reservation but still emits a leased-coordination event.
    await expect(adapter.reserve({ key: "quota", limit: 5, periodMs: 1_000, burst: 5, cost: 1,
      coordination: { strategy: "leased", maxLeaseUnits: 3, maxOutstandingUnits: 3, guardBandUnits: 1, leaseMs: 5_000 },
    })).resolves.toEqual({ admitted: true, remaining: 0, source: "leased" });
    expect(record).toHaveBeenCalledExactlyOnceWith({ type: "lease", durationMs: 0, outcome: "success",
      data: { key: "quota", operation: "exact-fallback", units: 1, remaining: 0 },
    });
  } finally {
    await adapter.close?.();
  }
});
