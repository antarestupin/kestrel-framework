import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { WorkflowClient } from "./client.js";
import { WorkflowExecutionNotFoundError, WorkflowExecutionTerminatedError } from "./errors.js";
import type { WorkflowCommandScheduledEvent, WorkflowHistoryEvent } from "./history.js";
import {
  buildWorkflowExecutionGraph,
  getWorkflowExecutionWaits,
  WorkflowOperations,
} from "./operations.js";
import { defineWorkflowSignal } from "./signal.js";
import { defineWorkflow } from "./workflow.js";
import { WorkflowScheduler } from "./scheduler.js";
import { EmbeddedWorkflowActivityTransport } from "./activity_transport.js";

describe("WorkflowOperations", () => {
  it("validates the signal owner and rejects empty deduplication keys before persistence", async () => {
    const signal = defineWorkflowSignal({ name: "approved", payload: z.string() });
    const workflow = defineWorkflow({ name: "approval", signals: [signal], handler: () => undefined });
    const adapter = new MemoryWorkflowAdapter({ createSignalId: () => "approval-signal" });
    await new WorkflowClient(adapter).start(workflow, null, { executionId: "approval-1" });
    const operations = new WorkflowOperations([workflow], adapter);
    const send = vi.spyOn(adapter, "sendSignal");
    const request = { executionId: "approval-1", signalName: signal.name, payload: "approved" };

    await expect(operations.signal({ ...request, executionId: "unknown" })).rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);
    await expect(new WorkflowOperations([], adapter).signal(request)).rejects.toThrow('Workflow definition "approval" is not deployed.');
    await expect(operations.signal({ ...request, signalName: "other" })).rejects.toThrow('Signal "other" is not declared by workflow "approval".');
    await expect(operations.signal({ ...request, idempotencyKey: "" })).rejects.toThrow("Workflow signal idempotency keys cannot be empty.");
    expect(send).not.toHaveBeenCalled();
    await expect(operations.signal(request)).resolves.toEqual({ id: "approval-signal", accepted: true });
    expect(send.mock.lastCall?.[0]).not.toHaveProperty("idempotencyKey");
    await expect(operations.signal({ ...request, idempotencyKey: "once" })).resolves.toEqual({ id: "approval-signal", accepted: true });
    await expect(operations.signal({ ...request, idempotencyKey: "once" })).resolves.toEqual({ id: "approval-signal", accepted: false });
  });

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
      description: "Fulfill one order.",
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

  it("sorts definition summaries and includes only each workflow's own executions and signals", async () => {
    const approval = defineWorkflowSignal({ name: "approval", payload: z.string() });
    const first = defineWorkflow({ name: "alpha", signals: [approval], handler: () => undefined });
    const last = defineWorkflow({ name: "zeta", handler: () => undefined });
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);
    await client.start(last, null);
    await expect(new WorkflowOperations([last, first], adapter).listDefinitions()).resolves.toStrictEqual([
      { name: "alpha", currentVersion: 1, supportedFrom: 1, signals: ["approval"], executions: [] },
      { name: "zeta", currentVersion: 1, supportedFrom: 1, signals: [], executions: [{ workflowName: "zeta", workflowVersion: 1, status: "queued", count: 1 }] },
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
    const record = vi.fn(() => { throw new Error("operator instrumentation failed"); });
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
    await expect(operations.retry("payment-v1")).resolves.toEqual(retried);
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: "lifecycle", outcome: "success",
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

  it("preserves the default termination reason when the operator omits it", async () => {
    const workflow = defineWorkflow({ name: "default-termination", handler: () => undefined });
    const adapter = new MemoryWorkflowAdapter();
    const handle = await new WorkflowClient(adapter).start(workflow, null, { executionId: "default-reason" });
    await new WorkflowOperations([workflow], adapter).terminate(handle.executionId);
    await expect(handle.result()).rejects.toEqual(
      new WorkflowExecutionTerminatedError(handle.executionId, "Terminated by an operator."),
    );
  });

  it("reports an invalid cursor through the execution search contract", async () => {
    const operations = new WorkflowOperations([], new MemoryWorkflowAdapter());
    await expect(operations.listExecutions({ limit: 1, cursor: "invalid" })).rejects.toThrow(
      "Workflow execution cursor is invalid.",
    );
  });

  it("requests cooperative cancellation through the operator surface", async () => {
    const workflow = defineWorkflow({ name: "cancel-operation", handler: () => undefined });
    const adapter = new MemoryWorkflowAdapter();
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    const operations = new WorkflowOperations([workflow], adapter);
    await expect(operations.cancel(handle.executionId)).resolves.toBe(true);
    expect((await operations.getExecution(handle.executionId)).history).toContainEqual(expect.objectContaining({ type: "cancellation-requested" }));
    await expect(handle.status()).resolves.toMatchObject({ cancellationRequested: true });
  });
});

describe("getWorkflowExecutionWaits", () => {
  it.each([
    { kind: "timer", payload: { durationMs: 120 }, delay: 120 },
    { kind: "signal", payload: { timeoutMs: 0 }, delay: 0 },
    { kind: "activity", payload: { options: { scheduleToCloseTimeoutMs: 250, startToCloseTimeoutMs: 42 } }, delay: 250 },
    { kind: "activity", payload: { options: { startToCloseTimeoutMs: 42 } } },
    { kind: "activity", payload: { options: null } },
    { kind: "activity", payload: { options: [] } },
    { kind: "activity", payload: { options: "historical" } },
    { kind: "activity", payload: { options: { scheduleToCloseTimeoutMs: "250" } } },
    { kind: "activity", payload: { options: { scheduleToCloseTimeoutMs: Infinity } } },
    { kind: "timer", payload: { durationMs: "120" } },
    { kind: "timer", payload: { durationMs: Infinity } },
    { kind: "signal", payload: {} },
    { kind: "child", payload: { durationMs: 120, timeoutMs: 200, options: { scheduleToCloseTimeoutMs: 250 } } },
    { kind: "timer", payload: null },
    { kind: "timer", payload: [] },
    { kind: "timer", payload: "historical" },
  ] satisfies readonly { kind: string; payload: WorkflowCommandScheduledEvent["payload"]; delay?: number }[])(
    "derives the $kind wait deadline from durable payload $payload",
    ({ kind, payload, delay }) => {
      const occurredAt = new Date("2026-01-01T00:00:00.000Z");
      const event: WorkflowCommandScheduledEvent = { type: "command-scheduled", kind, payload, eventIndex: 0, sequence: 0, target: "target", occurredAt };
      expect(getWorkflowExecutionWaits([event], "waiting")).toStrictEqual([{
        sequence: 0, kind, target: "target", scheduledAt: occurredAt,
        ...(delay === undefined ? {} : { deadline: new Date(occurredAt.getTime() + delay) }),
      }]);
    },
  );

  it("keeps only unfinished compensation waits and hides all waits once terminal", () => {
    const occurredAt = new Date("2026-01-01T00:00:00.000Z");
    const history: readonly WorkflowHistoryEvent[] = [
      { type: "command-scheduled", eventIndex: 0, sequence: 0, kind: "signal", target: "approval", payload: {}, occurredAt },
      { type: "cancellation-requested", eventIndex: 1, occurredAt },
      { type: "command-scheduled", eventIndex: 2, sequence: 1, kind: "activity", target: "refund", payload: {}, occurredAt },
      { type: "command-scheduled", eventIndex: 3, sequence: 2, kind: "timer", target: "sleep", payload: { durationMs: 8 }, occurredAt },
      { type: "command-completed", eventIndex: 4, sequence: 1, completionOrder: 0, occurredAt },
      { type: "signal-received", eventIndex: 5, signalId: "notice", name: "other", payload: null, occurredAt },
    ];
    const expected = [{
      sequence: 2, kind: "timer", target: "sleep", scheduledAt: occurredAt, deadline: new Date(occurredAt.getTime() + 8),
    }];
    expect(getWorkflowExecutionWaits(history)).toEqual(expected);
    expect(getWorkflowExecutionWaits(history, "waiting")).toEqual(expected);
    for (const status of ["cancelled", "completed", "failed", "terminated"] as const) {
      expect(getWorkflowExecutionWaits(history, status)).toEqual([]);
    }
  });
});

describe("buildWorkflowExecutionGraph", () => {
  it("omits completion timestamps on an active root and its waiting child", async () => {
    const workflow = defineWorkflow({ name: "graph.active", handler: () => undefined });
    const adapter = new MemoryWorkflowAdapter();
    const handle = await new WorkflowClient(adapter).start(workflow, null, { executionId: "active-root" });
    const execution = await handle.status();
    const child = { ...execution, executionId: "legacy-child", parentExecutionId: execution.executionId, status: "waiting" } as const;

    const graph = buildWorkflowExecutionGraph(execution, [], [child]);
    expect(graph.nodes).toHaveLength(2);
    for (const node of graph.nodes) expect(node).not.toHaveProperty("completedAt");
    expect(graph.edges).toEqual([{ kind: "child", from: "execution:active-root", to: "execution:legacy-child" }]);
  });

  it("does not associate a child with an activity that uses the same command position", async () => {
    const workflow = defineWorkflow({ name: "graph.position", handler: () => undefined });
    const adapter = new MemoryWorkflowAdapter();
    const handle = await new WorkflowClient(adapter).start(workflow, null, { executionId: "parent" });
    const execution = { ...await handle.status(), historyGeneration: 2 };
    // An explicit child ID from an earlier generation can match the generated
    // identity of this generation without belonging to its activity command.
    const child = { ...execution, executionId: "parent:0:generation-2", parentExecutionId: "parent", parentCommandSequence: 0 };
    const graph = buildWorkflowExecutionGraph(execution, [{
      type: "command-scheduled", eventIndex: 0, sequence: 0, kind: "activity", target: "work",
      payload: null, occurredAt: execution.createdAt,
    }], [child]);
    expect(graph.edges).toContainEqual({ kind: "child", from: "execution:parent", to: "execution:parent:0:generation-2" });
  });
  it("separates cancelled work from later compensation and preserves completion timestamps", async () => {
    const workflow = defineWorkflow({ name: "graph.cancelled", handler: () => undefined });
    const adapter = new MemoryWorkflowAdapter();
    const handle = await new WorkflowClient(adapter).start(workflow, null, { executionId: "graph-cancelled" });
    const execution = await handle.status();
    const occurredAt = execution.createdAt;
    const completedAt = new Date(occurredAt.getTime() + 20);
    const graph = buildWorkflowExecutionGraph({ ...execution, status: "terminated", completedAt }, [
      { type: "command-scheduled", eventIndex: 0, sequence: 0, kind: "timer", target: "sleep", payload: null, occurredAt },
      { type: "cancellation-requested", eventIndex: 1, occurredAt },
      { type: "command-scheduled", eventIndex: 2, sequence: 1, kind: "activity", target: "compensate", payload: null, occurredAt },
    ]);
    expect(graph.nodes).toStrictEqual([
      { id: "execution:graph-cancelled", kind: "execution", label: "graph.cancelled@1", status: "terminated",
        occurredAt, completedAt, executionId: "graph-cancelled" },
      { id: "command:0", kind: "command", label: "timer: sleep", status: "cancelled", occurredAt, sequence: 0 },
      { id: "command:1", kind: "command", label: "activity: compensate", status: "terminated", occurredAt, sequence: 1 },
    ]);
  });

  it("keeps a child from an archived generation attached to its execution rather than a reused command", async () => {
    const now = new Date(1_000);
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    const child = defineWorkflow({ name: "graph.child", handler: () => undefined });
    const parent = defineWorkflow({
      name: "graph.parent",
      handler: async (_input, context) => {
        if (context.generation === 1) {
          await context.runChild(child, null);
          return context.continueAsNew(null);
        }
        await context.sleep({ seconds: 1 });
      },
    });
    const client = new WorkflowClient(adapter);
    const scheduler = new WorkflowScheduler([parent, child], adapter, new EmbeddedWorkflowActivityTransport(() => undefined));
    const handle = await client.start(parent, null, { executionId: "root" });
    const operations = new WorkflowOperations([parent, child], adapter);
    await scheduler.runOnce();
    expect((await operations.getExecution(handle.executionId)).graph.edges).toContainEqual({
      from: "command:0", to: "execution:root:0", kind: "child",
    });
    for (let activation = 1; activation < 4; activation += 1) await scheduler.runOnce();

    const details = await operations.getExecution(handle.executionId);
    expect(details.execution.historyGeneration).toBe(2);
    expect(details.children).toMatchObject([{ executionId: "root:0", completedAt: now, status: "completed" }]);
    expect(details.graph.nodes).toContainEqual(expect.objectContaining({ id: "command:0", label: "timer: sleep" }));
    expect(details.graph.edges).toEqual([
      { from: "execution:root", to: "command:0", kind: "command" },
      { from: "execution:root", to: "execution:root:0", kind: "child" },
    ]);
  });

  it("links a generated child identity using the current history generation", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const child = defineWorkflow({ name: "graph.generated-child", handler: () => undefined });
    const parent = defineWorkflow({
      name: "graph.generated-parent",
      handler: async (_input, context) => {
        if (context.generation === 1) return context.continueAsNew(null);
        await context.runChild(child, null);
      },
    });
    const handle = await new WorkflowClient(adapter).start(parent, null, { executionId: "generated-parent" });
    const scheduler = new WorkflowScheduler([parent, child], adapter, new EmbeddedWorkflowActivityTransport(() => undefined));
    await scheduler.runOnce();
    await scheduler.runOnce();
    const { graph } = await new WorkflowOperations([parent, child], adapter).getExecution(handle.executionId);
    expect(graph.edges).toContainEqual({
      from: "command:0", to: "execution:generated-parent:0:generation-2", kind: "child",
    });
  });

  it("distinguishes unfinished commands from completed failures in the operator graph", async () => {
    const workflow = defineWorkflow({ name: "graph-statuses", handler: () => undefined });
    const adapter = new MemoryWorkflowAdapter();
    const { executionId } = await new WorkflowClient(adapter).start(workflow, null);
    const execution = (await adapter.get(executionId))!;
    const occurredAt = execution.createdAt;
    const graph = buildWorkflowExecutionGraph(execution, [
      { type: "command-scheduled", eventIndex: 0, sequence: 0, kind: "timer", target: "sleep", payload: { durationMs: 5 }, occurredAt },
      { type: "command-scheduled", eventIndex: 1, sequence: 1, kind: "activity", target: "charge", payload: null, occurredAt },
      { type: "command-completed", eventIndex: 2, sequence: 1, completionOrder: 0, error: { name: "GatewayError", message: "offline" }, occurredAt },
    ]);
    expect(graph.nodes.slice(1)).toEqual([
      { id: "command:0", kind: "command", label: "timer: sleep", status: "pending", occurredAt, sequence: 0 },
      { id: "command:1", kind: "command", label: "activity: charge", status: "failed", occurredAt, completedAt: occurredAt, sequence: 1 },
    ]);
  });
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
        kind: "child",
        target: "shipping.prepare",
        payload: { input: null, version: 1, executionId: "child" },
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

    expect(graph.nodes).toEqual([
      { id: "execution:root", kind: "execution", label: "orders.fulfill@1", status: "waiting", occurredAt, executionId: "root" },
      { id: "command:0", kind: "command", label: "child: shipping.prepare", status: "completed", occurredAt, completedAt: occurredAt, sequence: 0 },
      { id: "signal:signal-1", kind: "signal", label: "approved", status: "completed", occurredAt },
      { id: "execution:child", kind: "execution", label: "shipping.prepare@1", status: "queued", occurredAt, executionId: "child" },
    ]);
    expect(graph.edges).toEqual([
      { from: "execution:root", to: "command:0", kind: "command" },
      { from: "signal:signal-1", to: "execution:root", kind: "signal" },
      { from: "command:0", to: "execution:child", kind: "child" },
    ]);
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
