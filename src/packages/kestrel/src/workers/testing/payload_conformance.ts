import { describe, expect, it } from "vitest";

import { WorkerJobIdentityConflictError, WorkerPayloadSerializationError, WorkerPublicationBudgetError } from "../errors.js";
import type { WorkerAdapter, WorkerPublicationBudgets } from "../types.js";

/** Shared storage fixtures; each adapter suite owns setup and cleanup. */
export function workerPayloadConformance(createAdapter: (budgets?: WorkerPublicationBudgets) => WorkerAdapter): void {
  const reservation = {
    queues: [{ queue: "json-contract", reservationLimit: 10, allowOverflow: true }],
    totalLimit: 10,
    leaseMs: 60_000,
  };

  describe("JSON payload contract", () => {
    it("enforces only the configured job byte limit using native JSON UTF-8 bytes", async () => {
      const adapter = createAdapter({ maxJobBytes: 4 });
      // Both roots use four JSON bytes; correlation-free jobs add no metadata bytes.
      await adapter.enqueue([{ queue: "json-contract", payload: "é" }]);
      await adapter.enqueue([{ queue: "json-contract", payload: null }]);
      await expect(adapter.enqueue([{ queue: "json-contract", payload: "🙂" }]))
        .rejects.toMatchObject({
          name: "WorkerPublicationBudgetError", budget: "maxJobBytes", limit: 4, actual: 6, jobIndex: 0,
        });
      expect(await adapter.reserve(reservation)).toHaveLength(2);
    });

    it("enforces aggregate bytes independently and rejects the complete batch", async () => {
      const adapter = createAdapter({ maxBatchBytes: 8 });
      const job = { queue: "json-contract", payload: "é" };
      await expect(adapter.enqueue([job, job, job])).rejects.toMatchObject({
        budget: "maxBatchBytes", limit: 8, actual: 12, jobIndex: 2,
      });
      expect(await adapter.reserve(reservation)).toEqual([]);
      await adapter.enqueue([job, job]);
      expect(await adapter.reserve(reservation)).toHaveLength(2);
    });

    it("rejects batch count before serialization and leaves reservation size independent", async () => {
      const adapter = createAdapter({ maxBatchSize: 1 });
      await expect(adapter.enqueue<unknown>([
        { queue: "json-contract", payload: 1n },
        { queue: "json-contract", payload: "second" },
      ])).rejects.toMatchObject({ budget: "maxBatchSize", limit: 1, actual: 2 });
      // Separate publications do not share accounting; a consumer may pull both.
      await adapter.enqueue([{ queue: "json-contract", payload: "first" }]);
      await adapter.enqueue([{ queue: "json-contract", payload: "second" }]);
      expect(await adapter.reserve(reservation)).toHaveLength(2);
    });

    it("counts correlation bytes and enforces combined limits before publication", async () => {
      const correlation = { namespace: "test", id: "1", data: "é" };
      const bytes = 4 + Buffer.byteLength(JSON.stringify(correlation), "utf8");
      const adapter = createAdapter({ maxJobBytes: bytes, maxBatchBytes: bytes, maxBatchSize: 2 });
      const job = { queue: "json-contract", payload: "é", correlation };
      await expect(adapter.enqueue([job, job])).rejects.toMatchObject({
        budget: "maxBatchBytes", limit: bytes, actual: 2 * bytes,
      });
      expect(await adapter.reserve(reservation)).toEqual([]);
      await adapter.enqueue([job]);
      const tooSmall = createAdapter({ maxJobBytes: bytes - 1 });
      await expect(tooSmall.enqueue([job])).rejects.toMatchObject({ budget: "maxJobBytes", actual: bytes });
      expect(await adapter.reserve(reservation)).toHaveLength(1);
    });

    it("counts repeated identities as publication requests before deduplication", async () => {
      const adapter = createAdapter({ maxBatchBytes: 4 });
      const job = { queue: "json-contract", identity: "budget/duplicate", payload: "é" };
      await expect(adapter.enqueue([job, job])).rejects.toBeInstanceOf(WorkerPublicationBudgetError);
      expect(await adapter.reserve(reservation)).toEqual([]);
    });

    it("round-trips native JSON conversions and compares normalized identities", async () => {
      const adapter = createAdapter();
      const date = new Date("2026-01-01T00:00:00.000Z");
      const payload = {
        date, omitted: undefined, number: NaN, array: [undefined, Infinity, -0],
        custom: { toJSON: () => ({ value: "custom" }) },
      };
      const normalized = {
        date: date.toISOString(), number: null, array: [null, null, 0],
        custom: { value: "custom" },
      };
      const request = {
        queue: "json-contract", identity: "json-contract/1", payload,
        correlation: { namespace: "test", id: "1", data: { date } },
      };
      const [id, duplicate] = await adapter.enqueue([request, request]);
      expect(duplicate).toBe(id);
      await expect(adapter.enqueue([{
        ...request, payload: normalized,
        correlation: { namespace: "test", id: "1", data: { date: date.toISOString() } },
      }])).resolves.toEqual([id]);
      await expect(adapter.enqueue([{ ...request, payload: { different: true } }]))
        .rejects.toBeInstanceOf(WorkerJobIdentityConflictError);
      const jobs = await adapter.reserve(reservation);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toEqual(normalized);
      expect(jobs[0]?.correlation?.data).toEqual({ date: date.toISOString() });
    });

    it.each([
      ["null", null], ["boolean", true], ["number", 42],
      ["string", "hello"], ["array", [1, "two"]],
    ])("preserves a JSON %s root", async (_name, payload) => {
      const adapter = createAdapter();
      await adapter.enqueue([{ queue: "json-contract", payload }]);
      expect((await adapter.reserve(reservation))[0]?.payload).toEqual(payload);
    });

    it.each([
      { name: "undefined root", value: () => undefined },
      { name: "function root", value: () => () => {} },
      { name: "symbol root", value: () => Symbol("value") },
      { name: "BigInt", value: () => ({ value: 1n }) },
      { name: "cycle", value: () => {
        const value: { self?: unknown } = {};
        value.self = value;
        return value;
      } },
      { name: "throwing toJSON", value: () => ({ toJSON() { throw new Error("failure"); } }) },
    ])("rejects $name without partial publication", async ({ value }) => {
      const adapter = createAdapter();
      await expect(adapter.enqueue<unknown>([
        { queue: "json-contract", payload: "valid" },
        { queue: "json-contract", payload: value() },
      ])).rejects.toBeInstanceOf(WorkerPayloadSerializationError);
      expect(await adapter.reserve(reservation)).toEqual([]);
    });

    it("rejects unserializable correlation before publishing any job", async () => {
      const adapter = createAdapter();
      await expect(adapter.enqueue([
        { queue: "json-contract", payload: "valid" },
        { queue: "json-contract", payload: "valid", correlation: {
          namespace: "test", id: "1", data: 1n,
        } },
      ])).rejects.toBeInstanceOf(WorkerPayloadSerializationError);
      expect(await adapter.reserve(reservation)).toEqual([]);
    });
  });
}
