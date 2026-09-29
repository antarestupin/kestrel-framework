import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { WorkflowClient } from "./client.js";
import { WorkflowExecutionTerminatedError } from "./errors.js";
import {
  buildWorkflowExecutionGraph,
  getWorkflowExecutionWaits,
  WorkflowOperations,
} from "./operations.js";
import { defineWorkflowSignal } from "./signal.js";
import { defineWorkflow } from "./workflow.js";

describe("WorkflowOperations", () => {
  it("searches executions and exposes deployed version inventory", async () => {
    let currentTime = new Date("2026-01-01T00:00:00.000Z");
    const adapter = new MemoryWorkflowAdapter({ now: () => currentTime });
    const workflow = defineWorkflow({
      name: "orders.fulfill",
      description: "Fulfill one order.",
      version: { current: 3, supportedFrom: 2 },
      input: z.object({ orderId: z.string() }),
      concurrency: { keyed: { key: ({ orderId }) => orderId } },
      handler: () => undefined,
    });
    const client = new WorkflowClient(adapter);
    await client.start(workflow, { orderId: "order-a" }, { executionId: "execution-a" });
    currentTime = new Date("2026-01-02T00:00:00.000Z");
    await client.start(workflow, { orderId: "order-b" }, { executionId: "execution-b" });
    const operations = new WorkflowOperations([workflow], adapter);

    await expect(operations.listDefinitions()).resolves.toMatchObject([{
      name: workflow.name,
      currentVersion: 3,
      supportedFrom: 2,
      executions: [{ workflowVersion: 3, status: "queued", count: 2 }],
    }]);
    const firstPage = await operations.listExecutions({
      limit: 1,
      search: "order",
    });
    const secondPage = await operations.listExecutions({
      limit: 1,
      cursor: firstPage.nextCursor!,
    });

    expect(firstPage.items.map(({ executionId }) => executionId)).toEqual([
      "execution-b",
    ]);
    expect(secondPage.items.map(({ executionId }) => executionId)).toEqual([
      "execution-a",
    ]);
  });

  it("pauses future reservations, resumes durably and validates signals", async () => {
    const signal = defineWorkflowSignal({
      name: "approved",
      payload: z.object({ reviewer: z.string().refine(async () => true) }),
      validation: { input: "async" },
    });
    const workflow = defineWorkflow({
      name: "reviews.wait",
      signals: [signal],
      handler: () => undefined,
    });
    const adapter = new MemoryWorkflowAdapter();
    const operations = new WorkflowOperations([workflow], adapter);
    await new WorkflowClient(adapter).start(workflow, null, {
      executionId: "review-1",
    });

    await expect(operations.pause("review-1")).resolves.toBe(true);
    await expect(adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 1,
      leaseMs: 1_000,
    })).resolves.toHaveLength(0);
    await expect(operations.signal({
      executionId: "review-1",
      signalName: "approved",
      payload: { reviewer: "Ada" },
      idempotencyKey: "approval-1",
    })).resolves.toMatchObject({ accepted: true });
    await expect(operations.signal({
      executionId: "review-1",
      signalName: "approved",
      payload: { reviewer: 42 },
    })).rejects.toMatchObject({ name: "ZodError" });
    await expect(operations.resume("review-1")).resolves.toBe(true);
    await expect(adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 1,
      leaseMs: 1_000,
    })).resolves.toHaveLength(1);
  });

  it("retries failed executions under a linked identity and current version", async () => {
    const record = vi.fn();
    const workflow = defineWorkflow({
      name: "payments.capture",
      version: { current: 2, supportedFrom: 1 },
      input: z.object({ paymentId: z.string() }),
      handler: () => undefined,
    });
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start({
      executionId: "payment-v1",
      workflowName: workflow.name,
      workflowVersion: 1,
      input: { paymentId: "pay-1" },
    });
    adapter.failExecution("payment-v1", { name: "GatewayError", message: "offline" });
    const operations = new WorkflowOperations([workflow], adapter, {
      createExecutionId: () => "payment-retry",
      instrumentation: { record },
    });

    const retried = await operations.retry("payment-v1");

    expect(retried).toMatchObject({
      executionId: "payment-retry",
      retryOfExecutionId: "payment-v1",
      workflowVersion: 2,
      input: { paymentId: "pay-1" },
      status: "queued",
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      type: "lifecycle",
      data: expect.objectContaining({ operation: "retry" }),
    }));
  });

  it("force-terminates without compensation and closes result waiters", async () => {
    const workflow = defineWorkflow({
      name: "maintenance.long",
      handler: () => undefined,
    });
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);
    const handle = await client.start(workflow, null, { executionId: "long-1" });
    const operations = new WorkflowOperations([workflow], adapter);

    await expect(operations.terminate("long-1", "Unsafe deployment.")).resolves.toBe(true);
    await expect(handle.result()).rejects.toEqual(
      new WorkflowExecutionTerminatedError("long-1", "Unsafe deployment."),
    );
    await expect(adapter.reserveTasks({
      kinds: ["workflow"],
      limit: 1,
      leaseMs: 1_000,
    })).resolves.toHaveLength(0);
  });
});

describe("buildWorkflowExecutionGraph", () => {
  it("derives only the commands, signals and children observed in durable state", () => {
    const occurredAt = new Date("2026-01-01T00:00:00.000Z");
    const graph = buildWorkflowExecutionGraph({
      executionId: "root",
      workflowName: "orders.fulfill",
      workflowVersion: 1,
      historyGeneration: 1,
      input: null,
      status: "waiting",
      cancellationRequested: false,
      rootExecutionId: "root",
      concurrencyAdmitted: true,
      revision: 3,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }, [
      {
        type: "command-scheduled",
        eventIndex: 0,
        sequence: 0,
        kind: "activity",
        target: "stock.reserve",
        payload: null,
        occurredAt,
      },
      {
        type: "command-completed",
        eventIndex: 1,
        sequence: 0,
        completionOrder: 0,
        result: null,
        occurredAt,
      },
      {
        type: "signal-received",
        eventIndex: 2,
        signalId: "signal-1",
        name: "approved",
        payload: null,
        occurredAt,
      },
    ], [{
      executionId: "child",
      workflowName: "shipping.prepare",
      workflowVersion: 1,
      historyGeneration: 1,
      input: null,
      status: "queued",
      cancellationRequested: false,
      parentExecutionId: "root",
      parentCommandSequence: 0,
      rootExecutionId: "root",
      concurrencyAdmitted: true,
      revision: 0,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }]);

    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toContainEqual({
      from: "command:0",
      to: "execution:child",
      kind: "child",
    });
  });

  it("marks incomplete commands before cancellation as cancelled", () => {
    const scheduledAt = new Date("2026-01-01T00:00:00.000Z");
    const cancelledAt = new Date("2026-01-01T01:00:00.000Z");
    const history = [
      {
        type: "command-scheduled" as const,
        eventIndex: 0,
        sequence: 0,
        kind: "timer",
        target: "sleep",
        payload: { durationMs: 18_000_000 },
        occurredAt: scheduledAt,
      },
      {
        type: "cancellation-requested" as const,
        eventIndex: 1,
        occurredAt: cancelledAt,
      },
    ];
    const graph = buildWorkflowExecutionGraph({
      executionId: "cancelled-sleep",
      workflowName: "timer.cancel",
      workflowVersion: 1,
      historyGeneration: 1,
      input: null,
      status: "cancelled",
      cancellationRequested: true,
      rootExecutionId: "cancelled-sleep",
      concurrencyAdmitted: false,
      revision: 2,
      createdAt: scheduledAt,
      updatedAt: cancelledAt,
      completedAt: cancelledAt,
    }, history);

    expect(getWorkflowExecutionWaits(history)).toEqual([]);
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: "command:0",
      label: "timer: sleep",
      status: "cancelled",
    }));
  });

  it("marks incomplete commands as terminated and removes terminal waits", () => {
    const scheduledAt = new Date("2026-01-01T00:00:00.000Z");
    const terminatedAt = new Date("2026-01-01T01:00:00.000Z");
    const history = [{
      type: "command-scheduled" as const,
      eventIndex: 0,
      sequence: 0,
      kind: "timer",
      target: "sleep",
      payload: { durationMs: 18_000_000 },
      occurredAt: scheduledAt,
    }];
    const graph = buildWorkflowExecutionGraph({
      executionId: "terminated-sleep",
      workflowName: "timer.terminate",
      workflowVersion: 1,
      historyGeneration: 1,
      input: null,
      status: "terminated",
      cancellationRequested: false,
      rootExecutionId: "terminated-sleep",
      concurrencyAdmitted: false,
      revision: 2,
      createdAt: scheduledAt,
      updatedAt: terminatedAt,
      completedAt: terminatedAt,
    }, history);

    expect(getWorkflowExecutionWaits(history, "terminated")).toEqual([]);
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: "command:0",
      label: "timer: sleep",
      status: "terminated",
    }));
  });
});
