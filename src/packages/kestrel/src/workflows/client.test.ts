import {
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { MemoryWorkflowAdapter } from "./adapters/index.js";
import {
  defineWorkflow,
  defineWorkflowSignal,
  serializeWorkflowError,
  WorkflowClient,
  WorkflowExecutionCancelledError,
  WorkflowExecutionConflictError,
  WorkflowExecutionFailedError,
  WorkflowExecutionNotFoundError,
  WorkflowExecutionTerminatedError,
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
  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid atomic batch limit %s", (maxStartBatchSize) => {
    expect(() => new WorkflowClient(new MemoryWorkflowAdapter(), { maxStartBatchSize })).toThrow(
      "Workflow start batch size must be a positive integer.",
    );
  });

  it("rejects incomplete adapter replies instead of producing a partial batch of handles", async () => {
    const adapter = new MemoryWorkflowAdapter();
    vi.spyOn(adapter, "startMany").mockResolvedValue([]);
    await expect(new WorkflowClient(adapter).start(orderWorkflow, { count: 1 })).rejects.toThrow(
      "Workflow adapter returned an incomplete start batch.",
    );
  });

  it("rejects a start reply for a different workflow before exposing its handle", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const unrelated = await adapter.start({
      executionId: "unrelated-run", workflowName: "other.workflow", workflowVersion: 1, input: null,
    });
    vi.spyOn(adapter, "startMany").mockResolvedValueOnce([unrelated]);

    await expect(new WorkflowClient(adapter).start(orderWorkflow, { count: 1 })).rejects.toThrow(
      'Workflow execution "unrelated-run" belongs to "other.workflow", not "order.fulfill".',
    );
  });

  it("passes resolved concurrency to the adapter only when the workflow defines it", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const startMany = vi.spyOn(adapter, "startMany");
    const keyed = defineWorkflow({
      name: "keyed.invoices", input: z.object({ invoiceId: z.string() }),
      concurrency: { keyed: { key: ({ invoiceId }) => invoiceId } },
      handler: () => undefined,
    });
    const client = new WorkflowClient(adapter);
    await client.start(orderWorkflow, { count: 1 });
    await client.start(keyed, { invoiceId: "same-invoice" });

    // An external adapter receives optional metadata only when it has a value.
    expect(startMany.mock.calls[0]?.[0][0]).not.toHaveProperty("concurrency");
    expect(startMany.mock.calls[1]?.[0][0]).toMatchObject({
      concurrency: { keyed: { key: "same-invoice" } },
    });
  });

  it("returns the created handle even when recording start fails, and observes only the creation", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const record = vi.fn(() => { throw new Error("observer failed"); });
    const client = new WorkflowClient(adapter, { instrumentation: { record } });
    const options = { executionId: "observed-order" };
    await expect(client.start(orderWorkflow, { count: 1 }, options)).resolves.toMatchObject(options);
    await expect(client.start(orderWorkflow, { count: 1 }, options)).resolves.toMatchObject(options);
    expect(record).toHaveBeenCalledExactlyOnceWith({
      type: "lifecycle", outcome: "success", data: {
        executionId: options.executionId, workflowName: orderWorkflow.name, workflowVersion: 2,
        historyGeneration: 1, operation: "start", status: "queued",
      },
    });
  });

  it("reports a cancelled execution and rejects nonterminal wait replies", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const handle = await new WorkflowClient(adapter).start(orderWorkflow, { count: 1 });
    await expect(handle.cancel()).resolves.toBe(true);
    const active = await handle.status();
    expect(active.cancellationRequested).toBe(true);
    const wait = vi.spyOn(adapter, "waitForTerminal").mockResolvedValueOnce(active);
    await expect(handle.result()).rejects.toThrow(
      `Workflow adapter returned non-terminal status "${active.status}" while waiting for "${handle.executionId}".`,
    );
    wait.mockResolvedValueOnce({ ...active, status: "cancelled" });
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowExecutionCancelledError);
  });

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
    await expect(client.startMany([{ workflow: orderWorkflow, input: { count: 1 } }] as const)).resolves.toHaveLength(1);
  });

  it("reports fallback failure metadata for legacy terminal adapter replies", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const handle = await new WorkflowClient(adapter).start(orderWorkflow, { count: 1 });
    const active = await handle.status();
    const wait = vi.spyOn(adapter, "waitForTerminal").mockResolvedValueOnce({ ...active, status: "failed" });
    await expect(handle.result()).rejects.toMatchObject({
      name: "WorkflowExecutionFailedError",
      executionError: { name: "Error", message: "Workflow failed without durable error metadata." },
    });
    wait.mockResolvedValueOnce({ ...active, status: "terminated" });
    await expect(handle.result()).rejects.toEqual(
      new WorkflowExecutionTerminatedError(handle.executionId, "Terminated by an operator."),
    );
  });

  it("rejects a terminal reply for a different workflow before decoding output", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const decode = vi.fn(() => "unexpected output");
    const client = new WorkflowClient(adapter, { payloadCodec: { encode: () => null, decode } });
    const handle = await client.start(orderWorkflow, { count: 1 }, { executionId: "matching-run" });
    const execution = await handle.status();
    vi.spyOn(adapter, "waitForTerminal").mockResolvedValueOnce({
      ...execution, status: "completed", workflowName: "other.workflow", output: null,
    });
    await expect(handle.result()).rejects.toThrow(
      'Workflow execution "matching-run" belongs to "other.workflow", not "order.fulfill".',
    );
    expect(decode).not.toHaveBeenCalled();
  });

  it("does not decode an absent output when the declared output schema accepts it", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const decode = vi.fn();
    const client = new WorkflowClient(adapter, { payloadCodec: { encode: () => null, decode } });
    const workflow = defineWorkflow({ name: "optional.output", output: z.string().optional(), handler: () => undefined });
    const handle = await client.start(workflow, null, { executionId: "missing-output" });
    adapter.completeExecution(handle.executionId);
    await expect(handle.result()).resolves.toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
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

    await expect(handle.signal(approvalSignal, { approved: "yes" }, { idempotencyKey: "" }))
      .rejects.toThrow("Workflow signal idempotency keys cannot be empty.");
    expect(adapter.inspectSignals()).toEqual([]);

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
    // A typed signal without a key remains distinct from earlier deduplicated deliveries.
    const send = vi.spyOn(adapter, "sendSignal");
    await expect(handle.signal(approvalSignal, { approved: "yes" })).resolves.toMatchObject({ accepted: true });
    expect(send.mock.lastCall?.[0]).not.toHaveProperty("idempotencyKey");

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
    const previousDefinition = defineWorkflow({ name: "order.fulfill", handler: () => undefined });
    await expect(client.getHandle(previousDefinition, "known")).rejects.toBeInstanceOf(WorkflowExecutionVersionUnsupportedError);
  });
});
