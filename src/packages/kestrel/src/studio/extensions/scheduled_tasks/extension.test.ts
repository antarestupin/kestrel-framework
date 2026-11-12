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
    const nestedTask = defineScheduledTask({
      id: "billing.reminders",
      schedule: every({ minutes: 15 }),
      handler: () => undefined,
    });
    const secondBranch = defineScheduledTask({
      id: "billing.refunds", schedule: every({ minutes: 20 }), handler: () => undefined,
    });
    const registry = new ScheduledTaskRegistry()
      .registerCatalog(
        { billing: { reconciliation: applicationTask, reminders: { send: nestedTask }, refunds: { sync: secondBranch } } },
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
    const { server, app, studio } = await createTestApp(registry, adapter);

    const response = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/scheduled-tasks/catalog",
    });
    const catalog = response.json<StudioScheduledTaskCatalog>();

    expect(response.statusCode).toBe(200);
    expect(studio.getManifest().extensions[0]).toMatchObject({
      title: "Scheduled tasks", description: "Inspect recurring tasks and control their next executions.",
      pages: [{ title: "Scheduled tasks", description: "Schedules, execution state and runtime controls." }],
    });
    expect((await studio.defineHttpControllers()).slice(1).map(({ description }) => description)).toEqual([
      "List registered scheduled tasks and current state.", "Run, pause or resume one persistent scheduled task.",
    ]);
    expect(catalog.nodes).toMatchObject([
      {
        kind: "group",
        id: "application",
        name: "Application",
        children: [{
          kind: "group",
          id: "application.billing",
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
          }, {
            kind: "group",
            id: "application.billing.reminders",
            name: "reminders",
            children: [{ kind: "task", id: "billing.reminders", controllable: false }],
          }, {
            kind: "group",
            id: "application.billing.refunds",
            name: "refunds",
            children: [{ kind: "task", id: "billing.refunds", controllable: false }],
          }],
        }],
      },
      {
        kind: "group",
        id: "providers",
        name: "Providers",
        children: [{
          kind: "group",
          id: "providers.CacheProvider",
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

  it("retains the first future occurrence when resuming an interval schedule", async () => {
    const adapter = new MemoryScheduledTaskAdapter({ now: () => now });
    const task = defineScheduledTask({
      id: "first.future",
      schedule: every({ minutes: 2 }),
      handler: () => undefined,
    });
    const registry = new ScheduledTaskRegistry().register(task, { kind: "application" });
    await adapter.reconcile([{ taskId: task.id, nextScheduledAt: now }]);
    const { server, app } = await createTestApp(registry, adapter);
    try {
      expect((await control(server, task.id, "resume")).statusCode).toBe(204);
      await expect(adapter.listStates([task.id])).resolves.toMatchObject([
        { nextScheduledAt: new Date("2026-01-01T00:02:00.000Z") },
      ]);
    } finally {
      await server.close();
      await app.dispose();
    }
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
    // Even a stale adapter row for a process-local task must never allow a write.
    await adapter.reconcile([{ taskId: task.id, nextScheduledAt: now }]);
    const requestRun = vi.spyOn(adapter, "requestRun");
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
    expect(controlResponse.json()).toEqual({
      statusCode: 409, error: "Conflict", message: "Process-local scheduled tasks cannot be controlled from Studio.",
    });
    expect(requestRun).not.toHaveBeenCalled();

    await server.close();
    await app.dispose();
  });

  it("uses the current system time when resuming without an injected clock", async () => {
    const adapter = new MemoryScheduledTaskAdapter();
    const task = defineScheduledTask({
      id: "example.wall-clock",
      schedule: every({ minutes: 1, start: "immediate" }),
      handler: () => undefined,
    });
    const registry = new ScheduledTaskRegistry().register(task, { kind: "application" });
    await adapter.reconcile([{ taskId: task.id, nextScheduledAt: now }]);
    const { server, app } = await createTestApp(registry, adapter, { defaultState: "persistent" });

    try {
      const before = Date.now();
      expect((await control(server, task.id, "resume")).statusCode).toBe(204);
      const after = Date.now();
      const [state] = await adapter.listStates([task.id]);
      expect(state?.nextScheduledAt?.getTime()).toBeGreaterThanOrEqual(before + 60_000);
      expect(state?.nextScheduledAt?.getTime()).toBeLessThanOrEqual(after + 60_000);
    } finally {
      await server.close();
      await app.dispose();
    }
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
    const list = vi.spyOn(adapter, "listStates").mockResolvedValueOnce([{
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
      expect(list).toHaveBeenCalledExactlyOnceWith([cronTask.id, waitingTask.id]);
      const document = catalog.json<StudioScheduledTaskCatalog>();
      expect(document).toMatchObject({
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
            schedule: { kind: "cron", expression: "0 12 * * *" },
          }),
          expect.objectContaining({
            id: loopTask.id, schedule: { kind: "loop", delayMs: 1_000, start: "after-delay" },
          }),
        ]) }],
      });
      const application = document.nodes[0];
      if (application?.kind !== "group") throw new Error("Expected the application group.");
      const waitingDefinition = application.children.find((node) => node.id === waitingTask.id);
      expect(waitingDefinition).not.toHaveProperty("description");
      expect(waitingDefinition).not.toHaveProperty("schedule.timeZone");
      expect(catalog.body).not.toContain("internal stack");
      const unknown = await control(server, "unregistered", "pause");
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toEqual({
        statusCode: 404, error: "Not Found", message: 'Scheduled task "unregistered" is not registered.',
      });
      const waiting = await control(server, waitingTask.id, "run");
      expect(waiting.statusCode).toBe(409);
      expect(waiting.json()).toEqual({
        statusCode: 409, error: "Conflict", message: "The scheduled-task runtime has not registered this task yet.",
      });
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
  options: Parameters<typeof defineScheduledTasksStudioExtension>[2] = {
    defaultState: "persistent",
    now: () => now,
  },
) {
  const server = Fastify();
  const extension = defineScheduledTasksStudioExtension(registry, adapter, options);
  const studio = new Studio({ extensions: [extension] });
  const app = new App({});
  const manager = new HttpControllerManager(app, server);

  for (const controller of await studio.defineHttpControllers()) {
    manager.register(controller);
  }
  await app.start();

  return { server, app, studio };
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
