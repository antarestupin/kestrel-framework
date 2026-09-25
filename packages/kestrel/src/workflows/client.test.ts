import {
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import { z } from "zod";

import { MemoryWorkflowAdapter } from "./adapters/index.js";
import {
  defineWorkflow,
  defineWorkflowSignal,
  serializeWorkflowError,
  WorkflowClient,
  WorkflowExecutionConflictError,
  WorkflowExecutionFailedError,
  WorkflowExecutionNotFoundError,
  WorkflowExecutionVersionUnsupportedError,
} from "./index.js";

const approvalSignal = defineWorkflowSignal({
  name: "order.approval",
  payload: z.object({ approved: z.string().transform((value) => value === "yes") }),
});

const reminderSignal = defineWorkflowSignal({
  name: "order.reminder",
  payload: z.object({ message: z.string() }),
});

const orderWorkflow = defineWorkflow({
  name: "order.fulfill",
  version: { current: 2, supportedFrom: 1 },
  input: z.object({ count: z.coerce.number().int() }),
  output: z.object({ total: z.coerce.number() }),
  signals: [approvalSignal],
  handler: ({ count }) => ({ total: count }),
});

describe("WorkflowClient", () => {
  it("starts a typed heterogeneous batch in request order", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const executionIds = ["batch-order", "batch-notification"];
    const client = new WorkflowClient(adapter, {
      createExecutionId: () => executionIds.shift()!,
    });
    const notificationWorkflow = defineWorkflow({
      name: "notification.send",
      handler: () => undefined,
    });

    const handles = await client.startMany([
      { workflow: orderWorkflow, input: { count: 2 } },
      { workflow: notificationWorkflow, input: null },
    ] as const);

    expect(handles.map(({ executionId }) => executionId))
      .toEqual(["batch-order", "batch-notification"]);
    expectTypeOf(handles[0]).toEqualTypeOf<
      import("./client.js").WorkflowHandle<typeof orderWorkflow>
    >();
    expectTypeOf(handles[1]).toEqualTypeOf<
      import("./client.js").WorkflowHandle<typeof notificationWorkflow>
    >();
  });

  it("validates a complete batch before starting any execution", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);

    await expect(client.startMany([
      {
        workflow: orderWorkflow,
        input: { count: 2 },
        options: { executionId: "valid-batch-input" },
      },
      {
        workflow: orderWorkflow,
        input: { count: "invalid" },
        options: { executionId: "invalid-batch-input" },
      },
    ] as const)).rejects.toBeInstanceOf(z.ZodError);
    await expect(adapter.get("valid-batch-input")).resolves.toBeUndefined();
  });

  it("bounds atomic start batches before validating their inputs", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter, { maxStartBatchSize: 1 });

    await expect(client.startMany([
      { workflow: orderWorkflow, input: { count: 1 } },
      { workflow: orderWorkflow, input: { count: 2 } },
    ] as const)).rejects.toThrow(
      "the configured maximum is 1",
    );
  });

  it("validates input and starts with a generated execution ID", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter, {
      createExecutionId: () => "generated-execution",
    });

    const handle = await client.start(
      orderWorkflow,
      { count: "2" } as never,
    );

    expect(handle.executionId).toBe("generated-execution");
    await expect(handle.status()).resolves.toMatchObject({
      executionId: "generated-execution",
      workflowName: "order.fulfill",
      workflowVersion: 2,
      input: { count: 2 },
      status: "queued",
    });
    expectTypeOf(handle.result()).toEqualTypeOf<Promise<{ total: number }>>();
  });

  it("uses an execution ID as an idempotency key", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);
    const options = { executionId: "stable-execution" };

    const first = await client.start(orderWorkflow, { count: 2 }, options);
    const second = await client.start(
      orderWorkflow,
      { count: "2" } as never,
      options,
    );

    expect(second.executionId).toBe(first.executionId);
    await expect(client.start(
      orderWorkflow,
      { count: 3 },
      options,
    )).rejects.toBeInstanceOf(WorkflowExecutionConflictError);
  });

  it("does not start an execution when input validation fails", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);

    await expect(client.start(
      orderWorkflow,
      { count: "invalid" } as never,
      { executionId: "invalid-input" },
    )).rejects.toBeInstanceOf(z.ZodError);
    await expect(adapter.get("invalid-input")).resolves.toBeUndefined();
  });

  it("reattaches an old execution through a compatible newer definition", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);
    const options = { executionId: "versioned-execution" };
    await client.start(orderWorkflow, { count: 2 }, options);
    const newerDefinition = defineWorkflow({
      name: "order.fulfill",
      version: { current: 3, supportedFrom: 1 },
      input: z.object({ count: z.coerce.number().int() }),
      output: z.object({ total: z.coerce.number() }),
      signals: [approvalSignal],
      handler: ({ count }) => ({ total: count }),
    });

    const handle = await client.start(newerDefinition, { count: 2 }, options);

    await expect(handle.status()).resolves.toMatchObject({
      workflowVersion: 2,
    });
  });

  it("waits for and validates a transformed workflow result", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);
    const handle = await client.start(
      orderWorkflow,
      { count: 2 },
      { executionId: "result-execution" },
    );
    const result = handle.result();

    adapter.completeExecution(handle.executionId, { total: "4" });

    await expect(result).resolves.toEqual({ total: 4 });
  });

  it("rejects an invalid persisted workflow result", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);
    const handle = await client.start(orderWorkflow, { count: 2 });

    adapter.completeExecution(handle.executionId, { total: "invalid" });

    await expect(handle.result()).rejects.toBeInstanceOf(z.ZodError);
  });

  it("returns no result when the workflow omits its output schema", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);
    const workflow = defineWorkflow({
      name: "notification.send",
      handler: () => undefined,
    });
    const handle = await client.start(workflow, null);

    adapter.completeExecution(handle.executionId, "ignored");

    await expect(handle.result()).resolves.toBeUndefined();
    expectTypeOf(handle.result()).toEqualTypeOf<Promise<void>>();
  });

  it("surfaces durable workflow failures", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);
    const handle = await client.start(orderWorkflow, { count: 2 });

    adapter.failExecution(
      handle.executionId,
      serializeWorkflowError(new Error("payment failed")),
    );

    await expect(handle.result()).rejects.toMatchObject({
      name: "WorkflowExecutionFailedError",
      executionId: handle.executionId,
      executionError: { name: "Error", message: "payment failed" },
    } satisfies Partial<WorkflowExecutionFailedError>);
  });

  it("validates and deduplicates declared signals", async () => {
    const adapter = new MemoryWorkflowAdapter({
      createSignalId: () => "signal-id",
    });
    const client = new WorkflowClient(adapter);
    const handle = await client.start(orderWorkflow, { count: 2 });

    await expect(handle.signal(
      approvalSignal,
      { approved: "yes" },
      { idempotencyKey: "approval" },
    )).resolves.toEqual({ id: "signal-id", accepted: true });
    await expect(handle.signal(
      approvalSignal,
      { approved: "yes" },
      { idempotencyKey: "approval" },
    )).resolves.toEqual({ id: "signal-id", accepted: false });
    expect(adapter.inspectSignals()[0]?.payload).toEqual({ approved: true });

    if (false) {
      // @ts-expect-error Signal payloads retain their input contract.
      await handle.signal(approvalSignal, { approved: true });
      // @ts-expect-error Signals not declared by the workflow are rejected.
      await handle.signal(reminderSignal, { message: "Review the order" });
    }
  });

  it("rejects undeclared signals even when static typing is bypassed", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);
    const handle = await client.start(orderWorkflow, { count: 2 });

    await expect(handle.signal(
      reminderSignal as never,
      { message: "Review the order" } as never,
    )).rejects.toThrow("is not declared");
  });

  it("does not persist an invalid declared signal payload", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);
    const handle = await client.start(orderWorkflow, { count: 2 });

    await expect(handle.signal(
      approvalSignal,
      { approved: 1 } as never,
    )).rejects.toBeInstanceOf(z.ZodError);
    expect(adapter.inspectSignals()).toEqual([]);
  });

  it("rejects signals sent through an unsupported workflow definition", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);
    const handle = await client.start(orderWorkflow, { count: 2 });
    const unsupportedDefinition = defineWorkflow({
      name: "order.fulfill",
      version: { current: 3, supportedFrom: 3 },
      signals: [approvalSignal],
      handler: () => undefined,
    });

    await expect(client.signal(
      unsupportedDefinition,
      handle.executionId,
      approvalSignal,
      { approved: "yes" },
    )).rejects.toBeInstanceOf(WorkflowExecutionVersionUnsupportedError);
    expect(adapter.inspectSignals()).toEqual([]);
  });

  it("rejects unknown, mismatched, and unsupported execution handles", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const client = new WorkflowClient(adapter);
    await client.start(
      orderWorkflow,
      { count: 2 },
      { executionId: "known" },
    );

    await expect(client.getHandle(orderWorkflow, "unknown"))
      .rejects.toBeInstanceOf(WorkflowExecutionNotFoundError);

    const otherWorkflow = defineWorkflow({
      name: "order.other",
      input: z.object({ count: z.number() }),
      handler: () => undefined,
    });
    await expect(client.getHandle(otherWorkflow, "known"))
      .rejects.toBeInstanceOf(WorkflowExecutionConflictError);

    const newerDefinition = defineWorkflow({
      name: "order.fulfill",
      version: { current: 3, supportedFrom: 3 },
      input: z.object({ count: z.number() }),
      handler: () => undefined,
    });
    await expect(client.getHandle(newerDefinition, "known"))
      .rejects.toBeInstanceOf(WorkflowExecutionVersionUnsupportedError);
  });
});
