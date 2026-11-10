import { expect, it, vi } from "vitest";

import { workersConfigBase } from "../../configuration.js";
import { memoryWorkers } from "./definition.js";

it("creates independent stores with injected clock, tokens, grouping and publication tuning", async () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const definition = memoryWorkers({ now: () => now, createId: () => "job", createReservationToken: () => "token", acknowledgementGrouping: "queue" });
  const resolve = vi.fn(() => { throw new Error("Memory workers must not acquire infrastructure dependencies"); });
  const config = workersConfigBase.schema.parse({ publication: { maxBatchSize: 1 } });
  const first = definition.create(resolve, config);
  const second = definition.create(resolve, config);
  expect(first).not.toBe(second);
  expect(first.acknowledgementGrouping).toBe("queue");
  await expect(first.enqueue([{ queue: "q", payload: 1 }, { queue: "q", payload: 2 }])).rejects.toMatchObject({ budget: "maxBatchSize" });
  expect(await first.enqueue([{ queue: "q", payload: 1 }])).toEqual(["job"]);
  const request = { queues: [{ queue: "q", reservationLimit: 1, allowOverflow: false }], totalLimit: 1, leaseMs: 100 };
  expect(await first.reserve(request)).toMatchObject([{ id: "job", reservationToken: "token", reservedAt: now, createdAt: now }]);
  expect(await second.reserve(request)).toEqual([]);
  expect(resolve).not.toHaveBeenCalled();
});
