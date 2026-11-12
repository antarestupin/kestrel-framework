import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { App } from "../../../app/index.js";
import { HttpControllerManager } from "../../../http/index.js";
import {
  cron,
  every,
  loop,
  MemoryScheduledTaskAdapter,
  ScheduledTaskRegistry,
} from "../../../scheduled_tasks/index.js";
import { defineScheduledTask } from "../../../scheduled_tasks/task.js";
import { Studio } from "../../index.js";
import type { StudioScheduledTaskCatalog } from "./contract.js";
import { defineScheduledTasksStudioExtension } from "./extension.js";

const now = new Date("2026-01-01T00:00:00.000Z");

describe("scheduled-tasks Studio extension", () => {
  it("preserves catalog paths, provenance, schedules and execution state", async () => {
    const adapter = new MemoryScheduledTaskAdapter({ now: () => now });
    const applicationTask = defineScheduledTask({
      id: "billing.reconcile",
      description: "Reconcile invoices.",
      groups: ["maintenance"],
      schedule: every({ minutes: 5 }),
      handler: () => undefined,
    });
    const providerTask = defineScheduledTask({
      id: "maintenance.cache-prune",
      schedule: every({ hours: 1 }),
      handler: () => undefined,
    });
    const registry = new ScheduledTaskRegistry()
      .registerCatalog(
        { billing: { reconciliation: applicationTask } },
        { kind: "application" },
      )
      .register(
        providerTask,
        { kind: "provider", provider: "CacheProvider" },
      );
    await adapter.reconcile([
      {
        taskId: applicationTask.id,
        nextScheduledAt: new Date("2026-01-01T00:05:00.000Z"),
      },
      {
        taskId: providerTask.id,
        nextScheduledAt: new Date("2026-01-01T01:00:00.000Z"),
      },
    ]);
    const { server, app } = await createTestApp(registry, adapter);

    const response = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/scheduled-tasks/catalog",
    });
    const catalog = response.json<StudioScheduledTaskCatalog>();

    expect(response.statusCode).toBe(200);
    expect(catalog.nodes).toMatchObject([
      {
        kind: "group",
        name: "Application",
        children: [{
          kind: "group",
          name: "billing",
          children: [{
            kind: "task",
            id: "billing.reconcile",
            description: "Reconcile invoices.",
            groups: ["maintenance"],
            executionLog: true,
            observe: true,
            source: { kind: "application" },
            stateKind: "persistent",
            controllable: true,
            schedule: {
              kind: "every",
              intervalMs: 300_000,
              start: "after-interval",
            },
            state: {
              paused: false,
              nextScheduledAt: "2026-01-01T00:05:00.000Z",
            },
          }],
        }],
      },
      {
        kind: "group",
        name: "Providers",
        children: [{
          kind: "group",
          name: "CacheProvider",
          children: [{
            kind: "task",
            id: "maintenance.cache-prune",
            source: { kind: "provider", provider: "CacheProvider" },
          }],
        }],
      },
    ]);

    await server.close();
    await app.dispose();
  });

  it("runs paused tasks and resumes them at a newly calculated future occurrence", async () => {
    const adapter = new MemoryScheduledTaskAdapter({ now: () => now });
    const task = defineScheduledTask({
      id: "example.task",
      schedule: every({ minutes: 1, start: "immediate" }),
      handler: () => undefined,
    });
    const registry = new ScheduledTaskRegistry().register(
      task,
      { kind: "application" },
    );
    await adapter.reconcile([{ taskId: task.id, nextScheduledAt: now }]);
    const { server, app } = await createTestApp(registry, adapter);

    const pause = await control(server, task.id, "pause");
    const run = await control(server, task.id, "run");
    let [state] = await adapter.listStates([task.id]);

    expect(pause.statusCode).toBe(204);
    expect(run.statusCode).toBe(204);
    expect(state).toMatchObject({
      paused: true,
      manualRunRequestedAt: now,
    });

    const resume = await control(server, task.id, "resume");
    [state] = await adapter.listStates([task.id]);

    expect(resume.statusCode).toBe(204);
    expect(state).toMatchObject({
      paused: false,
      nextScheduledAt: new Date("2026-01-01T00:01:00.000Z"),
    });

    await server.close();
    await app.dispose();
  });

  it("exposes memory tasks without allowing cross-process controls", async () => {
    const adapter = new MemoryScheduledTaskAdapter({ now: () => now });
    const task = defineScheduledTask({
      id: "fast.local-task",
      runtime: { state: "memory" },
      schedule: every({ seconds: 1 }),
      handler: () => undefined,
    });
    const registry = new ScheduledTaskRegistry().register(
      task,
      { kind: "application" },
    );
    const { server, app } = await createTestApp(registry, adapter);

    const catalogResponse = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/scheduled-tasks/catalog",
    });
    const controlResponse = await control(server, task.id, "run");

    expect(catalogResponse.json()).toMatchObject({
      nodes: [{
        children: [{
          id: task.id,
          stateKind: "memory",
          controllable: false,
          unavailableReason: expect.stringContaining("Process-local"),
        }],
      }],
    });
    expect(controlResponse.statusCode).toBe(409);

    await server.close();
    await app.dispose();
  });

  it("distinguishes missing runtime state and publishes cron, loop, and prior run details", async () => {
    const adapter = new MemoryScheduledTaskAdapter({ now: () => now });
    const cronTask = defineScheduledTask({
      id: "cron-report",
      schedule: cron("0 9 * * *", { timeZone: "Europe/Paris" }),
      handler: () => undefined,
    });
    const waitingTask = defineScheduledTask({
      id: "waiting-report",
      schedule: cron("0 12 * * *"),
      handler: () => undefined,
    });
    const loopTask = defineScheduledTask({
      id: "local-loop",
      runtime: { state: "memory" },
      schedule: loop({ delay: { seconds: 1 }, start: "after-delay" }),
      handler: () => undefined,
    });
    const registry = new ScheduledTaskRegistry();
    for (const task of [cronTask, waitingTask, loopTask]) {
      registry.register(task, { kind: "application" });
    }
    await adapter.reconcile([{ taskId: cronTask.id, nextScheduledAt: now }]);
    vi.spyOn(adapter, "listStates").mockResolvedValueOnce([{
      taskId: cronTask.id,
      paused: true,
      activeRuns: 0,
      manualRunRequestedAt: now,
      lastStartedAt: now,
      lastCompletedAt: now,
      lastOutcome: "failure",
      lastError: { name: "TypeError", message: "Invalid account", stack: "internal stack" },
    }]);
    const { server, app } = await createTestApp(registry, adapter);
    try {
      const catalog = await server.inject({ url: "/_studio/api/extensions/scheduled-tasks/catalog" });
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json()).toMatchObject({
        nodes: [{ children: expect.arrayContaining([
          expect.objectContaining({
            id: cronTask.id,
            schedule: { kind: "cron", expression: "0 9 * * *", timeZone: "Europe/Paris" },
            state: expect.objectContaining({
              manualRunRequestedAt: now.toISOString(), lastStartedAt: now.toISOString(),
              lastCompletedAt: now.toISOString(), lastOutcome: "failure",
              lastError: { name: "TypeError", message: "Invalid account" },
            }),
          }),
          expect.objectContaining({
            id: waitingTask.id, controllable: false, unavailableReason: expect.stringContaining("Waiting"),
          }),
          expect.objectContaining({
            id: loopTask.id, schedule: { kind: "loop", delayMs: 1_000, start: "after-delay" },
          }),
        ]) }],
      });
      expect(catalog.body).not.toContain("internal stack");
      expect((await control(server, "unregistered", "pause")).statusCode).toBe(404);
      expect((await control(server, waitingTask.id, "run")).statusCode).toBe(409);
      expect((await control(server, cronTask.id, "resume")).statusCode).toBe(204);
      await expect(adapter.listStates([cronTask.id])).resolves.toMatchObject([
        { nextScheduledAt: new Date("2026-01-01T08:00:00.000Z") },
      ]);
    } finally {
      await server.close();
      await app.dispose();
    }
  });
});

async function createTestApp(
  registry: ScheduledTaskRegistry,
  adapter: MemoryScheduledTaskAdapter,
) {
  const server = Fastify();
  const extension = defineScheduledTasksStudioExtension(registry, adapter, {
    defaultState: "persistent",
    now: () => now,
  });
  const studio = new Studio({ extensions: [extension] });
  const app = new App({});
  const manager = new HttpControllerManager(app, server);

  for (const controller of await studio.defineHttpControllers()) {
    manager.register(controller);
  }
  await app.start();

  return { server, app };
}

function control(
  server: ReturnType<typeof Fastify>,
  taskId: string,
  action: "pause" | "resume" | "run",
) {
  return server.inject({
    method: "POST",
    url: "/_studio/api/extensions/scheduled-tasks/control",
    payload: { taskId, action },
  });
}
