import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { App } from "../app/index.js";
import { defineAdmissionPolicy, localResourcePressure, LocalResourcePressureMonitor, MemoryRateLimitAdapter, ThrottlingManager } from "../throttling/index.js";
import { MemoryWorkerAdapter } from "./adapters/memory/index.js";
import { defineWorkerAdapter } from "./adapter_definition.js";
import { workersConfigBase } from "./configuration.js";
import { workerRuntimeDependency } from "./dependencies.js";
import { WorkerProvider } from "./provider.js";
import { defineWorker, type WorkerExecutionContext } from "./worker.js";

const config = workersConfigBase.schema.parse({});

describe("worker provider contracts", () => {
  it.each(["standard", "minimal"] as const)("initializes the selected adapter according to the %s boot plan", async (mode) => {
    const create = vi.fn(() => new MemoryWorkerAdapter());
    const app = new App({});
    app.register(new WorkerProvider(config, defineWorkerAdapter({ dependencies: {}, capabilities: {}, create })));
    app.prepareBootPlan(["workers"], mode, "worker");
    try {
      expect(create).not.toHaveBeenCalled();
      await app.start();
      expect(create).toHaveBeenCalledTimes(mode === "minimal" ? 0 : 1);
    } finally { await app.dispose(); }
  });

  it("contributes the dedicated CLI workload and executes its resolved singleton runtime", async () => {
    const app = new App({});
    const logger = { error: vi.fn(), child: vi.fn() };
    logger.child.mockReturnValue(logger);
    app.container.registerValue("applicationLogger", logger);
    app.register(new WorkerProvider(config, defineWorkerAdapter({ dependencies: {}, capabilities: {}, create: () => new MemoryWorkerAdapter() })));
    try {
      const controller = app.catalog.cliControllers.definitions[0]!;
      expect(controller).toMatchObject({ command: "run workers", runtime: "worker", workloads: ["workers"], observe: false, dependencies: { runtime: workerRuntimeDependency } });
      expect(app.catalog.cliControllers.registrations[0]!.source).toMatchObject({ kind: "provider", provider: "WorkerProvider" });
      const runtime = app.container.resolve(workerRuntimeDependency);
      expect(app.container.resolve(workerRuntimeDependency)).toBe(runtime);
      expect(logger.child).toHaveBeenCalledExactlyOnceWith({ workload: "workers" });
      const run = vi.spyOn(runtime, "run").mockResolvedValue();
      // The CLI runner normally supplies the execution; this handler only owns
      // the runtime dependency and must await its long-running operation.
      await controller.handler!({ deps: { runtime } } as never);
      expect(run).toHaveBeenCalledOnce();
    } finally { await app.dispose(); }
  });

  it("forwards configured admission and completion ownership through its runtime", async () => {
    let pressure = 0.95;
    let tick = 0;
    const monitor = new LocalResourcePressureMonitor([{ supports: (id) => id === "cpu", read: () => pressure }], {
      monotonicNow: () => tick, healthyIntervalMs: 1, nearThresholdIntervalMs: 1, pressuredIntervalMs: 1,
    });
    const throttling = new ThrottlingManager(new MemoryRateLimitAdapter(), { namespace: "worker-provider-contract", resourcePressureMonitor: monitor });
    const admission = defineAdmissionPolicy({ id: "provider-pressure", limits: [localResourcePressure({ id: "provider-process", signals: { cpu: { degradedAt: 0.8, limitedAt: 0.9 } } })] });
    const adapter = new MemoryWorkerAdapter();
    const app = new App({});
    const logger = { error: vi.fn(), child: vi.fn() };
    logger.child.mockReturnValue(logger);
    app.container.registerValue("applicationLogger", logger);
    app.container.registerValue("throttling", throttling);
    const sink = { complete: vi.fn(async function (this: unknown) { expect(this).toBe(sink); }) };
    const handler = vi.fn((_job: unknown, _deps: unknown, context: WorkerExecutionContext) => { context.setResult("provider-result"); });
    const worker = defineWorker({ name: "provider-owned", queue: "provider-owned", input: z.null(), handler });
    app.catalog.contribute({ workers: { worker } }, { kind: "application" });
    app.register(new WorkerProvider(config, defineWorkerAdapter({ dependencies: {}, capabilities: {}, create: () => adapter }), { reservationPressure: admission, completionSinks: { owner: sink } }));
    try {
      await app.start();
      const runtime = app.container.resolve(workerRuntimeDependency);
      await adapter.enqueue([{ queue: worker.queue, payload: null, correlation: { namespace: "owner", id: "correlation" } }]);
      expect(await runtime.scheduler.runOnce()).toBe(0);
      expect(handler).not.toHaveBeenCalled();
      expect(sink.complete).not.toHaveBeenCalled();
      // Advance only the injected sampling clock before restoring admission.
      pressure = 0.1;
      tick = 2;
      expect(await runtime.scheduler.runOnce()).toBe(1);
      expect(handler).toHaveBeenCalledOnce();
      expect(sink.complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "completed", result: "provider-result", correlation: { namespace: "owner", id: "correlation" } }));
      expect(adapter.inspectJobs()).toEqual([]);
    } finally { await app.dispose(); await throttling.close(); }
  });
});
