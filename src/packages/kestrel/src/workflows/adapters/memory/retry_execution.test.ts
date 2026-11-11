import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { WorkflowExecutionConflictError, WorkflowExecutionNotFoundError } from "../../errors.js";
import type { ResolvedWorkflowConcurrency } from "../../concurrency.js";
import { MemoryWorkflowAdapter } from "./adapter.js";

const startedAt = new Date("2026-01-01T00:00:00.000Z");
const request = { executionId: "failed-source", workflowName: "orders.fulfill", workflowVersion: 1, input: { orderId: "order-1" } };
const error = { name: "TransientError", message: "The activity failed." };

/** Retrying an operator-selected execution must never attach to another execution's identity. */
describe("MemoryWorkflowAdapter execution retry contracts", () => {
  it("settles successful and rejected in-memory retry jobs without losing completion", async () => {
    let sequence = 0;
    const adapter = new MemoryWorkflowAdapter({ now: () => startedAt, createTaskId: () => `task-${++sequence}` });
    await adapter.start(request);
    adapter.failExecution(request.executionId, error);
    const outcomes: unknown[] = [];
    const observe = (result: unknown) => { outcomes.push(result); };
    void adapter.retryExecution({ sourceExecutionId: request.executionId, executionId: "settled-retry", workflowVersion: 2 }).then(observe, observe);
    void adapter.retryExecution({ sourceExecutionId: "missing-source", executionId: "rejected-retry", workflowVersion: 2 }).then(observe, observe);
    // This fixture has synchronous storage/ID generation and only promise continuations.
    // Drain those continuations once; a missing resolve/reject is an immediate assertion failure.
    await setImmediate();
    expect(outcomes).toHaveLength(2);
    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ created: true, execution: expect.objectContaining({ executionId: "settled-retry" }) }),
      expect.any(WorkflowExecutionNotFoundError),
    ]));
  });

  for (const conflict of ["enqueue", "reject", "return-existing"] as const) {
    for (const scope of ["execution", "active-work"] as const) {
      it(`creates its own retry identity under ${scope} ${conflict} admission`, async () => {
        const concurrency: ResolvedWorkflowConcurrency = {
          definitionLimit: 3,
          keyed: { key: "order-1", limit: 1, conflict, scope },
        };
        const adapter = new MemoryWorkflowAdapter({ now: () => startedAt });
        await adapter.start({ ...request, concurrency });
        adapter.failExecution(request.executionId, error);
        await adapter.start({ ...request, executionId: "unrelated-active", concurrency });
        const sourceBefore = await adapter.get(request.executionId);
        const activeBefore = await adapter.get("unrelated-active");

        const retried = await adapter.retryExecution({ sourceExecutionId: request.executionId, executionId: "requested-retry", workflowVersion: 2 });
        expect(retried).toMatchObject({
          created: true,
          execution: {
            executionId: "requested-retry", retryOfExecutionId: request.executionId,
            workflowName: request.workflowName, workflowVersion: 2, input: request.input,
            rootExecutionId: "requested-retry", concurrency,
            status: scope === "execution" ? "pending" : "queued",
            concurrencyAdmitted: scope !== "execution",
          },
        });
        expect(await adapter.get("requested-retry")).toEqual(retried.execution);
        expect(await adapter.get(request.executionId)).toEqual(sourceBefore);
        expect(await adapter.get("unrelated-active")).toEqual(activeBefore);
        expect(adapter.inspectTasks().filter((task) => task.executionId === "requested-retry"))
          .toHaveLength(scope === "execution" ? 0 : 1);
      });
    }
  }

  it("retries once, snapshots its result and rejects an unrelated reused target identity", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => startedAt });
    await adapter.start(request);
    adapter.failExecution(request.executionId, error);
    const retry = { sourceExecutionId: request.executionId, executionId: "requested-retry", workflowVersion: 2 };
    const first = await adapter.retryExecution(retry);
    const again = await adapter.retryExecution({ ...retry, workflowVersion: 3 });
    expect(first.created).toBe(true);
    expect(again).toEqual({ created: false, execution: first.execution });
    expect(adapter.inspectTasks().filter((task) => task.executionId === retry.executionId)).toHaveLength(1);
    (first.execution.input as { orderId: string }).orderId = "mutated-result";
    expect((await adapter.get(retry.executionId))?.input).toEqual(request.input);
    // Completed jobs must be forgotten so later idempotent reads observe current persisted state.
    adapter.completeExecution(retry.executionId, { completed: true });
    expect((await adapter.retryExecution(retry)).execution.status).toBe("completed");
    await adapter.start({ ...request, executionId: "unrelated-target" });
    const unrelated = await adapter.get("unrelated-target");
    await expect(adapter.retryExecution({ ...retry, executionId: "unrelated-target" })).rejects.toBeInstanceOf(WorkflowExecutionConflictError);
    expect(await adapter.get("unrelated-target")).toEqual(unrelated);
    const linked = await adapter.listExecutions({ retryOfExecutionId: request.executionId, limit: 10 });
    expect(linked.items.map(({ executionId }) => executionId)).toEqual([retry.executionId]);
  });

  it("deduplicates concurrent requests before the retry link is published", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => startedAt });
    await adapter.start(request);
    adapter.failExecution(request.executionId, error);
    const retry = { sourceExecutionId: request.executionId, executionId: "concurrent-retry", workflowVersion: 2 };
    const results = await Promise.allSettled([
      adapter.retryExecution(retry),
      adapter.retryExecution(retry),
      adapter.retryExecution({ ...retry, workflowVersion: 3 }),
    ]);
    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    const successful = results.map((result) => result.status === "fulfilled" ? result.value : undefined);
    expect(successful.map((result) => result?.created)).toEqual([true, false, false]);
    expect(successful.map((result) => result?.execution.workflowVersion)).toEqual([2, 2, 2]);
    expect(adapter.inspectTasks().filter((task) => task.executionId === retry.executionId)).toHaveLength(1);
  });

  it("publishes retry ownership before reentrant task-ID generation", async () => {
    let sequence = 0;
    let reenter = false;
    let nested: ReturnType<MemoryWorkflowAdapter["retryExecution"]> | undefined;
    const retry = { sourceExecutionId: request.executionId, executionId: "reentrant-retry", workflowVersion: 2 };
    const adapter = new MemoryWorkflowAdapter({ now: () => startedAt, createTaskId: () => {
      if (reenter) {
        reenter = false;
        nested = adapter.retryExecution(retry);
      }
      return `task-${++sequence}`;
    } });
    await adapter.start(request);
    adapter.failExecution(request.executionId, error);
    reenter = true;
    const first = adapter.retryExecution(retry);
    expect(nested).toBeDefined();
    const outcomes = await Promise.allSettled([first, nested!]);
    expect(outcomes.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    expect(outcomes.map((result) => result.status === "fulfilled" ? result.value.created : undefined)).toEqual([true, false]);
    expect(adapter.inspectTasks().filter((task) => task.executionId === retry.executionId)).toHaveLength(1);
  });

  it("does not retain a failed retry job or confuse concurrent source identities", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => startedAt });
    const retry = { sourceExecutionId: request.executionId, executionId: "retry-after-failure", workflowVersion: 2 };
    await expect(adapter.retryExecution(retry)).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    await adapter.start(request);
    adapter.failExecution(request.executionId, error);
    expect((await adapter.retryExecution(retry)).created).toBe(true);
    await adapter.start({ ...request, executionId: "another-failed-source" });
    adapter.failExecution("another-failed-source", error);
    const outcomes = await Promise.allSettled([
      adapter.retryExecution({ ...retry, executionId: "one-target" }),
      adapter.retryExecution({ ...retry, executionId: "one-target", sourceExecutionId: "another-failed-source" }),
    ]);
    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(outcomes[1]).toMatchObject({ status: "rejected", reason: expect.any(WorkflowExecutionConflictError) });
    expect((await adapter.get("one-target"))?.retryOfExecutionId).toBe(request.executionId);
  });

  it("requires a failed source and a valid new execution identity", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => startedAt });
    await adapter.start(request);
    const retry = { sourceExecutionId: request.executionId, executionId: "requested-retry", workflowVersion: 2 };
    await expect(adapter.retryExecution(retry)).rejects.toThrow(TypeError);
    adapter.completeExecution(request.executionId);
    await expect(adapter.retryExecution(retry)).rejects.toThrow(TypeError);
    await expect(adapter.retryExecution({ ...retry, sourceExecutionId: "missing-source" })).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    await expect(adapter.retryExecution({ ...retry, executionId: "" })).rejects.toThrow(TypeError);
    expect(await adapter.get(retry.executionId)).toBeUndefined();
  });

  it("restores the original start input after a failed continued generation", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => startedAt });
    await adapter.start(request);
    const [task] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    expect(await adapter.continueAsNew({ taskId: task!.id, reservationToken: task!.reservationToken, executionId: request.executionId, expectedRevision: 0, workflowVersion: 2, input: { nextGeneration: true } })).toBe(true);
    adapter.failExecution(request.executionId, error);
    const sourceBefore = await adapter.get(request.executionId);
    const result = await adapter.retryExecution({ sourceExecutionId: request.executionId, executionId: "retry-original-input", workflowVersion: 3 });
    expect(result.execution.input).toEqual(request.input);
    expect(result.execution.workflowVersion).toBe(3);
    expect(result.execution.historyGeneration).toBe(1);
    expect(await adapter.get(request.executionId)).toEqual(sourceBefore);
  });
});
