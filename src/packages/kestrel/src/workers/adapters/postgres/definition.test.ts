import { expect, it, vi } from "vitest";

import type { AdapterDependencyResolver } from "../../../di/adapter.js";
import { dep } from "../../../di/index.js";
import { workersConfigBase } from "../../configuration.js";
import type { PostgresWorkerDatabase } from "./adapter.js";
import { postgresWorkers } from "./definition.js";

it("resolves its explicit borrowed database lazily and retains publication tuning", async () => {
  const execute = vi.fn(async () => ({ rows: [] }));
  const database = { execute } as unknown as PostgresWorkerDatabase;
  const descriptor = dep<PostgresWorkerDatabase>("worker-contract-database");
  const resolve = vi.fn((requested: unknown) => { expect(requested).toBe(descriptor); return database; });
  const definition = postgresWorkers(descriptor);
  expect(resolve).not.toHaveBeenCalled();
  const resolver: AdapterDependencyResolver = <Value>(dependency: Parameters<AdapterDependencyResolver>[0]): Value => resolve(dependency) as unknown as Value;
  const adapter = definition.create(resolver, workersConfigBase.schema.parse({ publication: { maxBatchSize: 1 } }));
  expect(resolve).toHaveBeenCalledExactlyOnceWith(descriptor);
  // Publication rejection precedes infrastructure access; a real ownership
  // operation below must still use the same explicitly supplied database.
  await expect(adapter.enqueue([{ queue: "q", payload: 1 }, { queue: "q", payload: 2 }])).rejects.toMatchObject({ budget: "maxBatchSize" });
  expect(execute).not.toHaveBeenCalled();
  expect(await adapter.ack([{ jobId: "00000000-0000-4000-8000-000000000001", reservationToken: "00000000-0000-4000-8000-000000000002" }])).toEqual([]);
  expect(execute).toHaveBeenCalledOnce();
});
