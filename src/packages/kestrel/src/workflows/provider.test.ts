import { expect, it, vi } from "vitest";
import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import { WorkerProvider } from "../workers/provider.js";
import { workersConfigBase } from "../workers/configuration.js";
import { memoryWorkers } from "../workers/adapters/memory/index.js";
import { workerCorrelatedCompletionSinkDependency } from "../workers/dependencies.js";
import { WorkflowProvider } from "./provider.js";
import { defineWorkflowAdapter } from "./adapter_definition.js";
import { MemoryWorkflowAdapter, memoryWorkflows } from "./adapters/memory/index.js";
import { workflowAdapterDependency, workflowClientDependency } from "./dependencies.js";

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
  } finally { await app.dispose(); }
  expect(order).toEqual(["initialize", "adapter", "connection"]);
});

it("accepts worker routing registered later without resolving adapters during composition", async () => {
  const create = vi.fn(() => new MemoryWorkflowAdapter({ activityDispatchMode: "outbox" }));
  const app = new App({}).register(new WorkflowProvider(defineWorkflowAdapter({ dependencies: {}, capabilities: { activityDispatchMode: "outbox" }, create }), {
    activityTransport: "worker",
  }));
  try {
    app.register(new WorkerProvider(workersConfigBase.schema.parse({}), memoryWorkers()));
    expect(create).not.toHaveBeenCalled();
    await app.start();
    expect(app.container.resolve(workflowAdapterDependency).activityDispatchMode).toBe("outbox");
    expect(app.container.resolve(workerCorrelatedCompletionSinkDependency)).toBeDefined();
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
