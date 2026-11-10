import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MemoryWorkerAdapter } from "./adapters/memory/index.js";
import { WorkerClient } from "./client.js";
import { WorkerPayloadSerializationError } from "./errors.js";
import { defineWorker } from "./worker.js";
import type { EnqueueJobRequest } from "./types.js";

const worker = defineWorker({ name: "publication-contract", queue: "publication-contract", input: z.unknown(), handler: () => undefined });

describe("worker publication contracts", () => {
  it("forwards all publication metadata and detaches dates and correlation before external storage", async () => {
    const adapter = new MemoryWorkerAdapter();
    let received: readonly EnqueueJobRequest[] = [];
    vi.spyOn(adapter, "enqueue").mockImplementation(async (requests) => {
      received = requests;
      return ["published-job"];
    });
    const availableAt = new Date("2026-01-01T00:00:00.000Z");
    const correlation = { namespace: "workflow", id: "execution/1", data: { value: 1 } };
    const client = new WorkerClient(adapter);
    expect(await client.enqueue(worker, { value: 1 }, {
      identity: "logical-job", groupId: "serial-group", executionId: "first-execution", availableAt, correlation,
    })).toBe("published-job");
    availableAt.setTime(0);
    correlation.data.value = 2;
    expect(received).toEqual([{
      queue: worker.queue, payload: { value: 1 }, identity: "logical-job", groupId: "serial-group", executionId: "first-execution",
      availableAt: new Date("2026-01-01T00:00:00.000Z"), correlation: { namespace: "workflow", id: "execution/1", data: { value: 1 } },
    }]);
  });

  it("rejects one shared identity for several jobs before parsing or writing", async () => {
    const adapter = new MemoryWorkerAdapter();
    const enqueue = vi.spyOn(adapter, "enqueue");
    const parse = vi.fn((value: string) => value);
    const typed = defineWorker({ name: "identity-contract", queue: "identity-contract", input: z.string().transform(parse), handler: () => undefined });
    const client = new WorkerClient(adapter);
    await expect(client.enqueueMany(typed, ["first", "second"], { identity: "shared" })).rejects.toBeInstanceOf(TypeError);
    expect(parse).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(await client.enqueueMany(typed, ["first"], { identity: "single" })).toHaveLength(1);
  });

  it("rejects an adapter response without the requested single-job ID", async () => {
    const adapter = new MemoryWorkerAdapter();
    vi.spyOn(adapter, "enqueue").mockResolvedValue([]);
    await expect(new WorkerClient(adapter).enqueue(worker, "value")).rejects.toBeInstanceOf(Error);
  });

  it("accepts an empty publication without fabricating jobs", async () => {
    const adapter = new MemoryWorkerAdapter();
    const enqueue = vi.spyOn(adapter, "enqueue");
    expect(await new WorkerClient(adapter).enqueueMany(worker, [])).toEqual([]);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("counts UTF-8 payload and correlation bytes at the inclusive per-job boundary", async () => {
    const correlation = { namespace: "contract", id: "é" };
    const bytes = Buffer.byteLength(JSON.stringify("é")) + Buffer.byteLength(JSON.stringify(correlation));
    const allowed = new MemoryWorkerAdapter();
    await expect(new WorkerClient(allowed, { maxJobBytes: bytes }).enqueue(worker, "é", { correlation })).resolves.toEqual(expect.any(String));
    expect(allowed.inspectJobs()).toHaveLength(1);
    const denied = new MemoryWorkerAdapter();
    const write = vi.spyOn(denied, "enqueue");
    await expect(new WorkerClient(denied, { maxJobBytes: bytes - 1 }).enqueue(worker, "é", { correlation })).rejects.toMatchObject({
      budget: "maxJobBytes", actual: bytes, limit: bytes - 1, jobIndex: 0,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("accepts exact batch count and combined bytes, then rejects the next byte atomically", async () => {
    // A JSON string containing é occupies four bytes, including its quote delimiters.
    const allowed = new MemoryWorkerAdapter();
    const client = new WorkerClient(allowed, { maxBatchSize: 2, maxBatchBytes: 8 });
    expect(await client.enqueueMany(worker, ["é", "é"])).toHaveLength(2);
    const denied = new MemoryWorkerAdapter();
    const write = vi.spyOn(denied, "enqueue");
    await expect(new WorkerClient(denied, { maxBatchBytes: 8 }).enqueueMany(worker, ["é", "éa"])).rejects.toMatchObject({
      budget: "maxBatchBytes", actual: 9, limit: 8, jobIndex: 1,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("preserves the original serializer cause and rejects the complete publication", async () => {
    const adapter = new MemoryWorkerAdapter();
    const write = vi.spyOn(adapter, "enqueue");
    const failure = new Error("application serialization failed");
    const value = { toJSON: () => { throw failure; } };
    const outcome = new WorkerClient(adapter).enqueueMany(worker, ["first", value]);
    await expect(outcome).rejects.toBeInstanceOf(WorkerPayloadSerializationError);
    expect(await outcome.catch((error: unknown) => error instanceof Error ? error.cause : undefined)).toBe(failure);
    expect(write).not.toHaveBeenCalled();
  });
});
