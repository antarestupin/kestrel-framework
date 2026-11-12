import { pino } from "pino";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAction } from "../actions/index.js";
import { App, defineCatalog } from "../app/index.js";
import { dep } from "../di/index.js";
import { AsyncLocalObserverContext } from "../observability/index.js";
import { WorkerProvider } from "../workers/provider.js";
import { workersConfigBase } from "../workers/configuration.js";
import { memoryWorkers } from "../workers/adapters/memory/index.js";
import { WorkerCorrelatedCompletionRouter, workerCorrelatedCompletionSinkDependency } from "../workers/dependencies.js";
import { WorkflowProvider } from "./provider.js";
import { defineWorkflowAdapter } from "./adapter_definition.js";
import { MemoryWorkflowAdapter, memoryWorkflows } from "./adapters/memory/index.js";
import { workflowAdapterDependency, workflowClientDependency, workflowOperationsDependency, workflowRuntimeDependency } from "./dependencies.js";
import { defineWorkflowSignal } from "./signal.js";
import { defineWorkflow } from "./workflow.js";

it("initializes an external workflow backend after composition and closes before its connection", async () => {
  const order: string[] = [];
  const connection = dep<{ alive: boolean }>("externalWorkflowStorage");
  const create = vi.fn(({ connection }: { connection: { alive: boolean } }) => {
    expect(connection.alive).toBe(true);
    return new MemoryWorkflowAdapter();
  });
  const app = new App({}).register(new WorkflowProvider(defineWorkflowAdapter({
    dependencies: { connection }, capabilities: { activityDispatchMode: "embedded" },
    create,
    initialize: async () => { order.push("initialize"); },
    dispose: async () => { order.push("adapter"); },
  })));
  try {
    expect(create).not.toHaveBeenCalled();
    app.container.registerValue(connection.id, { alive: true }, {
      dispose: () => { order.push("connection"); },
    });
    await app.start();
    expect(app.container.resolve(workflowClientDependency)).toBe(app.container.resolve(workflowClientDependency));
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ connection: { alive: true } }, { activityDispatchMode: "embedded" });
  } finally { await app.dispose(); }
  expect(order).toEqual(["initialize", "adapter", "connection"]);
});

it("accepts worker routing registered later without resolving adapters during composition", async () => {
  const create = vi.fn(() => new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" }));
  const app = new App({}).register(new WorkflowProvider(defineWorkflowAdapter({ dependencies: {}, capabilities: { activityDispatchMode: "outbox" }, create }), {
    activityTransport: "worker",
  }));
  try {
    const logger = pino({ enabled: false });
    const child = vi.spyOn(logger, "child");
    app.container.registerValue("applicationLogger", logger);
    app.register(new WorkerProvider(workersConfigBase.schema.parse({}), memoryWorkers()));
    expect(create).not.toHaveBeenCalled();
    expect(app.catalog.workers.registrations).toContainEqual(expect.objectContaining({
      path: ["workflowRuntime", "workflowActivity"],
      definition: expect.objectContaining({ name: "kestrel.workflow.activity" }),
    }));
    const router = app.container.resolve(workerCorrelatedCompletionSinkDependency);
    if (!(router instanceof WorkerCorrelatedCompletionRouter)) throw new Error("Expected the Worker completion router");
    const registerRoute = vi.spyOn(router, "register");
    await app.start();
    expect(app.container.resolve(workflowAdapterDependency).activityDispatchMode).toBe("outbox");
    expect(registerRoute).toHaveBeenCalledExactlyOnceWith("workflow.activity", expect.objectContaining({ complete: expect.any(Function) }));
    const runtime = app.container.resolve(workflowRuntimeDependency);
    expect(app.container.resolve(workflowRuntimeDependency)).toBe(runtime);
    expect(runtime.state).toMatchObject({ scheduler: { status: "idle" }, dispatcher: { status: "idle" } });
    expect(child).toHaveBeenCalledWith({ workload: "workflows" });
  } finally { await app.dispose(); }
});

it("contributes the standalone workflow CLI and dispatches it to the composed runtime", async () => {
  const app = new App({}).register(new WorkflowProvider(memoryWorkflows()));
  app.container.registerValue("applicationLogger", pino({ enabled: false }));
  try {
    const registration = app.catalog.cliControllers.registrations.find(({ definition }) => definition.command === "run workflows");
    expect(registration).toMatchObject({
      path: ["workflowRuntime", "runWorkflows"], source: { kind: "provider", provider: "WorkflowProvider" },
      definition: {
        description: expect.stringMatching(/\S/u), dependencies: { runtime: workflowRuntimeDependency },
        runtime: "workflow", workloads: ["workflows"], observe: false,
      },
    });
    const controller = registration?.definition;
    if (controller?.source !== "standalone") throw new Error("Expected the standalone workflow CLI");
    expect(app.catalog.workers.definitions).toEqual([]);
    await app.start();
    const runtime = app.container.resolve(workflowRuntimeDependency);
    const run = vi.spyOn(runtime, "run").mockResolvedValue(undefined);
    const execution = await app.createExecutionScope();
    try {
      await controller.handler({ input: {}, deps: { runtime }, execution });
      expect(run).toHaveBeenCalledOnce();
    } finally { await execution.dispose("success"); }
  } finally { await app.dispose(); }
});

it("rejects a sink that cannot register Workflow Worker completion routes", async () => {
  const app = new App({}).register(new WorkflowProvider(memoryWorkflows({ activityDispatchMode: "outbox" }), { activityTransport: "worker" }));
  app.container.registerValue(workerCorrelatedCompletionSinkDependency.id, { complete: async () => undefined });
  try { await expect(app.start()).rejects.toThrow("require the Worker completion router"); }
  finally { await app.dispose(); }
});

it("rejects resolution of a Worker-backed runtime without the Worker client", async () => {
  const app = new App({}).register(new WorkflowProvider(memoryWorkflows({ activityDispatchMode: "outbox" }), { activityTransport: "worker" }));
  app.container.registerValue("applicationLogger", pino({ enabled: false }));
  try { expect(() => app.container.resolve(workflowRuntimeDependency)).toThrow("require WorkerProvider"); }
  finally { await app.dispose(); }
});

it.each(["absent", "working", "failing", "observer-failing"] as const)("records workflow telemetry in %s mode", async (mode) => {
  const workflow = defineWorkflow({ name: "provider.observed", handler: () => { throw new Error("retryable execution"); } });
  const app = new App({}, { catalog: defineCatalog({ runtime: { workflows: { workflow } } }) });
  const observerContext = new AsyncLocalObserverContext();
  const observer = { record: vi.fn(() => {
    if (mode === "observer-failing") throw new Error("Observer failed");
  }) };
  const instrumentation = { record: vi.fn(() => {
    if (mode === "failing") throw new Error("Custom instrumentation failed");
  }) };
  app.container.registerValue("observerContext", observerContext);
  app.container.registerValue("applicationLogger", pino({ enabled: false }));
  app.register(new WorkflowProvider(memoryWorkflows(), mode === "absent" ? {} : { instrumentation }));
  try {
    await app.start();
    const client = app.container.resolve(workflowClientDependency);
    const handle = await observerContext.run(observer, () => client.start(workflow, null, { executionId: "observed" }));
    expect(observer.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "workflow.lifecycle" }),
      expect.objectContaining({ executionId: "observed", operation: "start" }), { outcome: "success" });
    await client.start(workflow, null, { executionId: "outside-observer" });
    expect(observer.record).toHaveBeenCalledOnce();
    expect(instrumentation.record).toHaveBeenCalledTimes(mode === "absent" ? 0 : 2);
    const runtime = app.container.resolve(workflowRuntimeDependency);
    await observerContext.run(observer, () => runtime.scheduler.runOnce());
    expect(observer.record).toHaveBeenCalledWith(expect.objectContaining({ name: "workflow.task" }),
      expect.objectContaining({ executionId: "observed", taskKind: "workflow" }), expect.any(Object));
    expect(observer.record).toHaveBeenCalledWith(expect.objectContaining({ name: "workflow.lifecycle" }),
      expect.objectContaining({ executionId: "observed", operation: "failed" }), { outcome: "failure" });
    if (mode !== "absent") {
      expect(instrumentation.record).toHaveBeenCalledWith(expect.objectContaining({
        type: "lifecycle", data: expect.objectContaining({ executionId: "observed", operation: "failed" }),
      }));
    }
    await expect(handle.status()).resolves.toMatchObject({ status: "failed" });
    const operations = app.container.resolve(workflowOperationsDependency);
    await observerContext.run(observer, () => operations.retry(handle.executionId, "observed-retry"));
    expect(observer.record).toHaveBeenCalledWith(expect.objectContaining({ name: "workflow.lifecycle" }),
      expect.objectContaining({ executionId: "observed-retry", operation: "retry" }), { outcome: "success" });
  } finally { await app.dispose(); }
});

it("rejects worker-backed boot without a Worker completion router", async () => {
  const app = new App({}).register(new WorkflowProvider(memoryWorkflows({ activityDispatchMode: "outbox" }), {
    activityTransport: "worker",
  }));
  try {
    await expect(app.start()).rejects.toThrow("Worker-backed workflow activities require WorkerProvider.");
  } finally { await app.dispose(); }
});

it("shares the selected payload codec and instrumentation across the composed workflow APIs", async () => {
  const signal = defineWorkflowSignal({ name: "provider.amount", payload: z.number() });
  const increment = defineAction({ name: "provider.increment", input: z.number(), output: z.number(), handler: (value) => value + 1 });
  const workflow = defineWorkflow({ name: "provider.codec", input: z.number(), output: z.number(), signals: [signal],
    handler: async (initial, context) => context.run(increment, initial + await context.waitForSignal(signal)) });
  const payloadCodec = {
    encode: (value: unknown) => JSON.stringify(value) ?? "null",
    decode: (value: unknown): unknown => JSON.parse(String(value)),
  };
  const record = vi.fn();
  const app = new App({}, { catalog: defineCatalog({ actions: { increment }, runtime: { workflows: { workflow } } }) }).register(
    new WorkflowProvider(memoryWorkflows(), { payloadCodec, instrumentation: { record }, completionBatchSize: 1 }),
  );
  app.container.registerValue("applicationLogger", pino({ enabled: false }));
  try {
    await app.start();
    const client = app.container.resolve(workflowClientDependency);
    const runtime = app.container.resolve(workflowRuntimeDependency);
    const operations = app.container.resolve(workflowOperationsDependency);
    expect(app.container.resolve(workflowOperationsDependency)).toBe(operations);
    const handle = await client.start(workflow, 2, { executionId: "provider-codec" });
    await runtime.scheduler.runOnce();
    await operations.signal({ executionId: handle.executionId, signalName: signal.name, payload: 4 });
    for (let cycle = 0; cycle < 4; cycle++) await runtime.scheduler.runOnce();
    await expect(handle.status()).resolves.toMatchObject({ status: "completed" });
    await expect(handle.result()).resolves.toBe(7);
    const { history } = await operations.getExecution(handle.executionId);
    expect(history).toContainEqual(expect.objectContaining({ type: "signal-received", payload: "4" }));
    expect(history).toContainEqual(expect.objectContaining({ type: "command-completed", result: "7" }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: "lifecycle", data: expect.objectContaining({ operation: "start" }) }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: "lifecycle", data: expect.objectContaining({ operation: "completed" }) }));
  } finally { await app.dispose(); }
});

it("rejects incompatible workflow transport metadata without opening a backend", async () => {
  const app = new App({});
  try {
    expect(() => app.register(new WorkflowProvider(memoryWorkflows(), {
      activityTransport: "worker",
    })))
      .toThrow('requires an adapter with "outbox" dispatch');
  } finally { await app.dispose(); }
});

it("validates actual workflow dispatch behavior and still disposes rejected adapters", async () => {
  const dispose = vi.fn();
  const app = new App({}).register(new WorkflowProvider(defineWorkflowAdapter({
    dependencies: {}, capabilities: { activityDispatchMode: "embedded" },
    create: () => new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" }), dispose,
  })));
  try { await expect(app.start()).rejects.toThrow("does not match"); }
  finally { await app.dispose(); }
  expect(dispose).toHaveBeenCalledOnce();
});

it("leaves even worker-backed storage unresolved in minimal mode", async () => {
  const create = vi.fn(() => new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" }));
  const app = new App({}).register(new WorkflowProvider(defineWorkflowAdapter({ dependencies: {}, capabilities: { activityDispatchMode: "outbox" }, create }), {
    activityTransport: "worker",
  }));
  app.prepareBootPlan([], "minimal");
  try { await app.start(); } finally { await app.dispose(); }
  expect(create).not.toHaveBeenCalled();
});
