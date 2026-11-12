import { describe, expect, it, vi } from "vitest";

import { WorkerCorrelatedCompletionRouter, workerAdapterDependency, workerClientDependency, workerCorrelatedCompletionSinkDependency, workerRuntimeDependency } from "./dependencies.js";
import { WorkerBatchResultError, WorkerJobIdentityConflictError, WorkerPayloadSerializationError, WorkerPublicationBudgetError, WorkerRetryError } from "./errors.js";
import { serializeWorkerError, type WorkerCorrelatedCompletion } from "./types.js";

describe("worker public metadata contracts", () => {
  it("exposes the dependency identifiers used by providers and consumers", () => {
    expect([workerAdapterDependency.id, workerClientDependency.id, workerRuntimeDependency.id, workerCorrelatedCompletionSinkDependency.id]).toEqual(["workerAdapter", "workerClient", "workerRuntime", "workerCorrelatedCompletionSink"]);
  });

  it("routes constructor and later registrations with the original completion and receiver", async () => {
    const seen: WorkerCorrelatedCompletion[] = [];
    const first = { complete: vi.fn(async function (this: unknown, completion: WorkerCorrelatedCompletion) { expect(this).toBe(first); seen.push(completion); }) };
    const second = { complete: vi.fn(async () => undefined) };
    const router = new WorkerCorrelatedCompletionRouter({ first });
    router.register("second", second);
    const completion: WorkerCorrelatedCompletion = { jobId: "job", identity: "logical", correlation: { namespace: "first", id: "correlation" }, status: "completed", result: { durable: true } };
    await router.complete(completion);
    expect(seen[0]).toBe(completion);
    expect(second.complete).not.toHaveBeenCalled();
    const failure: WorkerCorrelatedCompletion = { jobId: "other", correlation: { namespace: "second", id: "correlation" }, status: "failed", error: { name: "Error", message: "failed" } };
    await router.complete(failure);
    expect(second.complete).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("rejects empty, duplicate and unknown namespaces without replacing an owner", async () => {
    const sink = { complete: vi.fn(async () => undefined) };
    const router = new WorkerCorrelatedCompletionRouter();
    expect(() => router.register("", sink)).toThrow("Worker correlation namespaces cannot be empty.");
    expect(() => new WorkerCorrelatedCompletionRouter({ "": sink })).toThrow("Worker correlation namespaces cannot be empty.");
    router.register("known", sink);
    expect(() => router.register("known", { complete: vi.fn() })).toThrow('Worker correlation namespace "known" is already registered.');
    expect(() => router.complete({ jobId: "job", correlation: { namespace: "missing", id: "id" }, status: "completed" }))
      .toThrow('No Worker completion sink handles namespace "missing".');
    const known: WorkerCorrelatedCompletion = { jobId: "job", correlation: { namespace: "known", id: "id" }, status: "completed" };
    await router.complete(known);
    expect(sink.complete).toHaveBeenCalledExactlyOnceWith(known);
  });

  it("propagates a result owner's exact rejection", async () => {
    const failure = new Error("owner persistence unavailable");
    const router = new WorkerCorrelatedCompletionRouter({ owner: { complete: async () => { throw failure; } } });
    await expect(router.complete({ jobId: "job", correlation: { namespace: "owner", id: "id" }, status: "completed" })).rejects.toBe(failure);
  });

  it("retains retry tuning, native cause and error classification", () => {
    const cause = new Error("dependency failure");
    expect(new WorkerRetryError("retry requested", 0, { cause, maxAttempts: 1 })).toMatchObject({ name: "WorkerRetryError", message: "retry requested", retryDelayMs: 0, maxAttempts: 1, cause });
    expect(new WorkerRetryError("default", 0.5).maxAttempts).toBeUndefined();
    expect(new WorkerPayloadSerializationError({ cause })).toMatchObject({
      name: "WorkerPayloadSerializationError", message: "Worker payload and correlation must have a JSON representation.", cause,
    });
    expect(new WorkerBatchResultError("invalid batch")).toMatchObject({ name: "WorkerBatchResultError", message: "invalid batch" });
    expect(new WorkerJobIdentityConflictError("identity")).toMatchObject({
      name: "WorkerJobIdentityConflictError", identity: "identity",
      message: 'Worker job identity "identity" already belongs to another job.',
    });
    expect(new WorkerPublicationBudgetError("maxJobBytes", 2, 3, 0)).toMatchObject({
      name: "WorkerPublicationBudgetError", budget: "maxJobBytes", limit: 2, actual: 3, jobIndex: 0,
      message: "Worker publication maxJobBytes exceeded: 3 > 2.",
    });
  });

  it.each([-1, NaN, Infinity])("rejects invalid native retry delays %s", (delay) => {
    expect(() => new WorkerRetryError("retry", delay)).toThrow("Worker retry delays must be non-negative finite numbers.");
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid native attempt limits %s", (maxAttempts) => {
    expect(() => new WorkerRetryError("retry", 0, { maxAttempts })).toThrow("Worker retry maxAttempts must be a positive integer.");
  });

  it("bounds native error stacks and supports stackless and non-error throws", () => {
    const error = new TypeError("worker failed");
    error.stack = "0123456789";
    expect(serializeWorkerError(error, 4)).toEqual({ name: "TypeError", message: "worker failed", stack: "0123" });
    error.stack = "x".repeat(8_001);
    expect(serializeWorkerError(error).stack).toHaveLength(8_000);
    delete error.stack;
    expect(serializeWorkerError(error)).toEqual({ name: "TypeError", message: "worker failed" });
    for (const value of ["text failure", null, 42, { reason: "failed" }]) expect(serializeWorkerError(value)).toEqual({ name: "Error", message: String(value) });
  });
});
