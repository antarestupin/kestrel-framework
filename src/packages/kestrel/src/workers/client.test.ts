import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { MemoryWorkerAdapter } from "./adapters/memory/index.js";
import { WorkerClient } from "./client.js";
import { defineWorker } from "./worker.js";
import { WorkerPayloadSerializationError } from "./errors.js";
import type { EnqueueJobRequest } from "./types.js";

describe("WorkerClient", () => {
  it("checks count before schemas and stops preparing after byte overflow", async () => {
    const adapter = new MemoryWorkerAdapter();
    let writes = 0;
    adapter.enqueue = async () => { writes++; return []; };
    let validations = 0;
    const worker = defineWorker({
      name: "budgets", queue: "budgets",
      input: z.string().transform(async (value) => { validations++; return value; }),
      validation: { input: "async" },
      handler: () => {},
    });
    const counted = new WorkerClient(adapter, { maxBatchSize: 1 });
    await expect(counted.enqueueMany(worker, ["a", "b"])).rejects.toMatchObject({ budget: "maxBatchSize" });
    expect(validations).toBe(0);
    const bytes = new WorkerClient(adapter, { maxBatchBytes: 4 });
    await expect(bytes.enqueueMany(worker, ["é", "é", "é"])).rejects.toMatchObject({
      budget: "maxBatchBytes", limit: 4, actual: 8, jobIndex: 1,
    });
    expect(validations).toBe(2);
    expect(writes).toBe(0);
  });

  it("counts schema-transformed JSON and keeps budgets independent between calls", async () => {
    const adapter = new MemoryWorkerAdapter();
    const budgets = { maxJobBytes: 4 };
    const client = new WorkerClient(adapter, budgets);
    // Later changes to application configuration cannot silently loosen policy.
    budgets.maxJobBytes = 100;
    const worker = defineWorker({
      name: "transformed", queue: "transformed",
      input: z.string().transform((value) => value.repeat(2)), handler: () => {},
    });
    await expect(client.enqueue(worker, "é")).rejects.toMatchObject({ budget: "maxJobBytes", actual: 6 });
    await client.enqueue(worker, "a");
    await client.enqueue(worker, "b");
    expect(adapter.inspectJobs().map((job) => job.payload)).toEqual(["aa", "bb"]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid configured limits (%s)", (limit) => {
      const adapter = new MemoryWorkerAdapter();
      for (const key of ["maxJobBytes", "maxBatchBytes", "maxBatchSize"] as const) {
        expect(() => new WorkerClient(adapter, { [key]: limit })).toThrow(TypeError);
      }
    },
  );

  it("sends JSON snapshots to external adapters before publication", async () => {
    const adapter = new MemoryWorkerAdapter();
    const received: EnqueueJobRequest[] = [];
    // Capture the public adapter boundary without built-in normalization.
    adapter.enqueue = async (requests) => {
      received.push(...requests);
      return ["job"];
    };
    const client = new WorkerClient(adapter);
    const worker = defineWorker({
      name: "json", queue: "json", input: z.unknown(), handler: () => {},
    });
    const source = { nested: { value: 1 }, date: new Date("2026-01-01T00:00:00.000Z") };
    await client.enqueue(worker, source);
    source.nested.value = 2;
    expect(received[0]?.payload).toEqual({
      nested: { value: 1 }, date: "2026-01-01T00:00:00.000Z",
    });
    await expect(client.enqueueMany(worker, ["valid", 1n]))
      .rejects.toBeInstanceOf(WorkerPayloadSerializationError);
    expect(received).toHaveLength(1);
  });

  it("requires an async payload policy before writing the batch", async () => {
    const adapter = new MemoryWorkerAdapter({ createId: () => "async-job" });
    const client = new WorkerClient(adapter);
    const options = {
      name: "async-worker",
      queue: "async-worker",
      input: z.string().transform(async (value) => value.toUpperCase()),
      handler: () => {},
    };
    await expect(client.enqueue(defineWorker(options), "value")).rejects.toThrow(/Promise/);
    expect(adapter.inspectJobs()).toHaveLength(0);
    await client.enqueue(defineWorker({ ...options, validation: { input: "async" } }), "value");
    expect(adapter.inspectJobs()[0]?.payload).toBe("VALUE");
  });

  it("validates and transforms payloads before enqueueing", async () => {
    const adapter = new MemoryWorkerAdapter({ createId: () => "job" });
    const client = new WorkerClient(adapter);
    const worker = defineWorker({
      name: "typed",
      queue: "typed",
      input: z.object({ count: z.coerce.number().int() }),
      handler: async () => undefined,
    });

    await expect(client.enqueue(worker, { count: "2" } as never))
      .resolves.toBe("job");
    expect(adapter.inspectJobs()[0]?.payload).toEqual({ count: 2 });
  });

  it("forwards an execution ID for first-attempt correlation", async () => {
    const adapter = new MemoryWorkerAdapter({ createId: () => "job" });
    const client = new WorkerClient(adapter);
    const worker = defineWorker({
      name: "correlated",
      queue: "correlated",
      input: z.string(),
      handler: async () => undefined,
    });
    const executionId = "00000000-0000-4000-8000-000000000001";

    await client.enqueue(worker, "payload", { executionId });

    expect(adapter.inspectJobs()[0]?.executionId).toBe(executionId);
  });

  it("does not enqueue an invalid payload", async () => {
    const adapter = new MemoryWorkerAdapter();
    const client = new WorkerClient(adapter);
    const worker = defineWorker({
      name: "typed",
      queue: "typed",
      input: z.object({ value: z.string().min(1) }),
      handler: async () => undefined,
    });

    await expect(client.enqueue(worker, { value: "" })).rejects.toThrow();
    expect(adapter.inspectJobs()).toHaveLength(0);
  });

  it("validates and enqueues multiple jobs through one adapter call", async () => {
    let id = 0;
    const adapter = new MemoryWorkerAdapter({
      createId: () => `job-${++id}`,
    });
    const client = new WorkerClient(adapter);
    const worker = defineWorker({
      name: "bulk",
      queue: "bulk",
      input: z.object({ count: z.coerce.number().int() }),
      handler: async () => undefined,
    });

    await expect(client.enqueueMany(
      worker,
      [{ count: "1" }, { count: "2" }],
      { groupId: "group" },
    )).resolves.toEqual(["job-1", "job-2"]);
    expect(adapter.inspectJobs()).toMatchObject([
      { payload: { count: 1 }, groupId: "group" },
      { payload: { count: 2 }, groupId: "group" },
    ]);
  });

  it("does not partially enqueue an invalid payload batch", async () => {
    const adapter = new MemoryWorkerAdapter();
    const client = new WorkerClient(adapter);
    const worker = defineWorker({
      name: "bulk-validation",
      queue: "bulk-validation",
      input: z.object({ value: z.string().min(1) }),
      handler: async () => undefined,
    });

    await expect(client.enqueueMany(
      worker,
      [{ value: "valid" }, { value: "" }],
    )).rejects.toThrow();
    expect(adapter.inspectJobs()).toHaveLength(0);
  });
});
