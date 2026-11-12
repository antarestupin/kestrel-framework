import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { App } from "../app/index.js";
import { backgroundRuntimeDependency } from "./dependencies.js";
import { BackgroundProvider } from "./provider.js";
import { BackgroundRuntime, type BackgroundWorkload } from "./runtime.js";

const registration = { workers: "workerRuntime", "scheduled-tasks": "scheduledTaskRuntime", workflows: "workflowRuntime" } as const;

/** Compose public providers against borrowed lifecycle stubs without starting pollers. */
describe("background provider contracts", () => {
  it.each([[], ["workers"], ["scheduled-tasks"], ["workflows"], ["workers", "scheduled-tasks", "workflows"]] satisfies BackgroundWorkload[][])("discovers selected registrations %j and owns a singleton launcher", async (...available) => {
    const app = new App({});
    for (const workload of available) app.container.registerValue(registration[workload], { start: vi.fn(), stop: vi.fn(async () => undefined) });
    app.register(new BackgroundProvider());
    try {
      const runtime = app.container.resolve(backgroundRuntimeDependency);
      expect(runtime).toBeInstanceOf(BackgroundRuntime);
      expect(app.container.resolve(backgroundRuntimeDependency)).toBe(runtime);
      expect(runtime.availableWorkloads()).toEqual(available);
      const { definition: controller, source, path } = app.catalog.cliControllers.registrations[0]!;
      expect(source).toEqual({ kind: "provider", provider: "BackgroundProvider" });
      expect(path).toEqual(["backgroundRuntime", "runBackground"]);
      expect(controller).toMatchObject({ command: "run background", description: "Run selected background workloads.", runtime: "background", observe: false, dependencies: { runtime: backgroundRuntimeDependency }, bindings: { workloads: { kind: "option", name: "workload", repeatable: true } } });
      expect(controller.inputSchema.parse({})).toEqual({ workloads: [] });
      expect(z.toJSONSchema(controller.inputSchema)).toMatchObject({
        properties: { workloads: { description: "Background workload to run; repeatable." } },
      });
      expect(controller.inputSchema.safeParse({ workloads: ["unsupported"] }).success).toBe(false);
      expect(controller.inputSchema.parse({ workloads: ["workers", "scheduled-tasks", "workflows"] })).toEqual({ workloads: ["workers", "scheduled-tasks", "workflows"] });
      expect(controller.prepareWorkloads?.(["run", "background"])).toEqual(available);
      const run = vi.spyOn(runtime, "run").mockResolvedValue();
      await controller.handler!({ input: { workloads: available }, deps: { runtime } } as never);
      expect(run).toHaveBeenCalledExactlyOnceWith(available);
      expect(backgroundRuntimeDependency.id).toBe("backgroundRuntime");
    } finally { await app.dispose(); }
  });
});
