import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { MemoryWorkerAdapter } from "./adapters/memory/index.js";
import { WorkerClient } from "./client.js";
import { defineWorker } from "./worker.js";

describe("WorkerClient", () => {
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
