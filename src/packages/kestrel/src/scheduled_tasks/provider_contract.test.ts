import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/index.js";
import { dep } from "../di/index.js";
import type { Locks } from "../lock/index.js";
import { defineScheduledTaskAdapter } from "./adapter_definition.js";
import { MemoryScheduledTaskAdapter } from "./adapters/memory/index.js";
import { scheduledTasksConfigBase } from "./configuration.js";
import { scheduledTaskAdapterDependency, scheduledTaskRuntimeDependency } from "./dependencies.js";
import { ScheduledTaskProvider } from "./provider.js";
import { ScheduledTaskRuntime } from "./runtime.js";

const owned: App<Record<string, never>>[] = [];
afterEach(async () => { for (const app of owned.splice(0)) await app.dispose(); });

/** Keep borrowed infrastructure separate from the backend recipe's owned lifecycle. */
function setup(interval = 0) {
  const config = scheduledTasksConfigBase.schema.parse({ expiredRunPruneIntervalSeconds: interval, expiredRunPruneBatchSize: 7 });
  const backend = new MemoryScheduledTaskAdapter();
  const dependency = dep<MemoryScheduledTaskAdapter>("external-scheduled-backend");
  const create = vi.fn(({ backend: selected }: { backend: MemoryScheduledTaskAdapter }, context: typeof config) => {
    expect(context).toBe(config);
    return selected;
  });
  const initialize = vi.fn(async () => undefined);
  const dispose = vi.fn(async () => undefined);
  const definition = defineScheduledTaskAdapter({ dependencies: { backend: dependency }, capabilities: {}, create, initialize, dispose });
  const app = new App<Record<string, never>>({});
  owned.push(app);
  app.register(new ScheduledTaskProvider(config, definition));
  app.container.registerValue(dependency.id, backend);
  return { app, backend, config, create, initialize, dispose };
}

describe("scheduled task provider composition", () => {
  it.each(["minimal", "standard"] as const)("boots the external backend only for %s application mode when required", async (mode) => {
    const { app, backend, create, initialize, dispose } = setup();
    app.prepareBootPlan([], mode);
    expect(create).not.toHaveBeenCalled();
    await app.start();
    expect(create).toHaveBeenCalledTimes(mode === "standard" ? 1 : 0);
    expect(initialize).toHaveBeenCalledTimes(mode === "standard" ? 1 : 0);
    if (mode === "standard") {
      expect(app.container.resolve(scheduledTaskAdapterDependency)).toBe(backend);
      expect(app.container.resolve(scheduledTaskAdapterDependency)).toBe(backend);
      expect(initialize).toHaveBeenCalledExactlyOnceWith(backend);
    }
    await app.dispose();
    expect(dispose).toHaveBeenCalledTimes(mode === "standard" ? 1 : 0);
  });

  it("constructs a singleton runtime with the selected adapter and a workload logger", async () => {
    const { app, create } = setup();
    const childLogger = { error: vi.fn() } as unknown as Logger;
    const child = vi.fn(() => childLogger);
    app.container.registerValue("applicationLogger", { child } as unknown as Logger);
    app.container.registerValue("locks", {} as Locks);
    const runtime = app.container.resolve(scheduledTaskRuntimeDependency);
    expect(runtime).toBeInstanceOf(ScheduledTaskRuntime);
    expect(app.container.resolve(scheduledTaskRuntimeDependency)).toBe(runtime);
    expect(create).toHaveBeenCalledOnce();
    expect(child).toHaveBeenCalledExactlyOnceWith({ workload: "scheduled-tasks" });
    expect(scheduledTaskAdapterDependency.id).toBe("scheduledTaskAdapter");
    expect(scheduledTaskRuntimeDependency.id).toBe("scheduledTaskRuntime");
  });

  it("contributes a selectable CLI contract and forwards its parsed selection", async () => {
    const { app } = setup();
    const { definition: controller, source, path } = app.catalog.cliControllers.registrations[0]!;
    expect(source).toEqual({ kind: "provider", provider: "ScheduledTaskProvider" });
    expect(path).toEqual(["scheduledTaskRuntime", "runScheduledTasks"]);
    expect(controller).toMatchObject({ command: "run scheduled-tasks", runtime: "scheduled-tasks", workloads: ["scheduled-tasks"], observe: false, dependencies: { runtime: scheduledTaskRuntimeDependency }, bindings: { groups: { kind: "option", name: "group", repeatable: true }, taskIds: { kind: "option", name: "task", repeatable: true } } });
    expect(controller.inputSchema.parse({})).toEqual({ groups: [], taskIds: [] });
    expect(controller.inputSchema.safeParse({ groups: [""] }).success).toBe(false);
    expect(controller.inputSchema.safeParse({ taskIds: [""] }).success).toBe(false);
    const input = controller.inputSchema.parse({ groups: ["maintenance"], taskIds: ["billing.task"] });
    const run = vi.fn(async () => undefined);
    await app.start();
    const execution = await app.createExecutionScope();
    try {
      if (controller.source !== "standalone") throw new Error("Expected standalone scheduled-task controller");
      await controller.handler({ input, deps: { runtime: { run } }, execution });
      expect(run).toHaveBeenCalledExactlyOnceWith(input);
    } finally { await execution.dispose("success"); }
  });

  it("disables maintenance at zero interval", () => {
    expect(setup().app.catalog.scheduledTasks.tasks).toEqual([]);
  });

  it.each([0, 2])("prunes the configured batch and logs only a non-empty result of %s", async (removed) => {
    const { app, backend } = setup(13);
    const task = app.catalog.scheduledTasks.tasks[0]!;
    expect(task).toMatchObject({ id: "maintenance.scheduled-task-runs-prune", groups: ["maintenance"], overlap: "skip", executionLog: false, observe: false, runtime: { state: "persistent", coordination: "distributed" }, dependencies: { adapter: scheduledTaskAdapterDependency } });
    expect(task.schedule).toMatchObject({ kind: "every", intervalMs: 13_000 });
    const prune = vi.spyOn(backend, "pruneExpiredRuns").mockResolvedValue(removed);
    const debug = vi.fn();
    await task.handler({ adapter: backend, logger: { debug } }, { signal: new AbortController().signal, scheduledAt: new Date(0), trigger: "scheduled", deferNextRun: () => undefined });
    expect(prune).toHaveBeenCalledExactlyOnceWith({ limit: 7 });
    expect(debug).toHaveBeenCalledTimes(removed > 0 ? 1 : 0);
    if (removed > 0) expect(debug).toHaveBeenCalledWith({ removed }, expect.any(String));
  });
});
