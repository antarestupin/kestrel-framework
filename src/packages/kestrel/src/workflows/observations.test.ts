import { describe, expect, it, vi } from "vitest";

import { EmbeddedWorkflowActivityTransport } from "./activity_transport.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { WorkflowClient } from "./client.js";
import { recordWorkflowInstrumentation, type WorkflowInstrumentationEvent } from "./observations.js";
import { WorkflowScheduler } from "./scheduler.js";
import { defineWorkflow } from "./workflow.js";

describe("workflow instrumentation", () => {
  it("routes lifecycle and task metrics without adding an absent duration", () => {
    const observer = { record: vi.fn() };
    const identity = { executionId: "example", workflowName: "observe.run", workflowVersion: 1 };
    const lifecycle = { ...identity, operation: "start", status: "queued" } as const;
    const task = { ...identity, historyGeneration: 1, taskKind: "workflow", result: "committed", attempt: 1, queueAgeMs: 0 } as const;
    recordWorkflowInstrumentation(observer, { type: "lifecycle", data: lifecycle, outcome: "success" });
    recordWorkflowInstrumentation(observer, { type: "task", data: task, outcome: "success", durationMs: 0 });
    expect(observer.record.mock.calls).toStrictEqual([
      [expect.objectContaining({ name: "workflow.lifecycle", category: "workflow" }), lifecycle, { outcome: "success" }],
      [expect.objectContaining({ name: "workflow.task", category: "workflow" }), task, { outcome: "success", durationMs: 0 }],
    ]);
  });

  it("records starts, waits, completions, queue age, timer lag and task duration", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const events: WorkflowInstrumentationEvent[] = [];
    const instrumentation = { record: (event: WorkflowInstrumentationEvent) => events.push(event) };
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    const workflow = defineWorkflow({
      name: "timers.observe",
      handler: async (_input, context) => {
        await context.sleep({ milliseconds: 5 });
      },
    });
    const client = new WorkflowClient(adapter, { instrumentation });
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
      { instrumentation, now: () => now.getTime() },
    );

    await client.start(workflow, null, { executionId: "observed-timer" });
    await scheduler.runOnce();
    now = new Date("2026-01-01T00:00:00.015Z");
    const getExecution = vi.spyOn(adapter, "get");
    await scheduler.runOnce();
    expect(getExecution).not.toHaveBeenCalled();
    getExecution.mockRestore();
    await scheduler.runOnce();

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "lifecycle",
        data: expect.objectContaining({ operation: "start" }),
      }),
      expect.objectContaining({
        type: "lifecycle",
        data: expect.objectContaining({ operation: "wait" }),
      }),
      expect.objectContaining({
        type: "lifecycle",
        data: expect.objectContaining({ operation: "completed" }),
      }),
      expect.objectContaining({
        type: "task",
        durationMs: expect.any(Number),
        data: expect.objectContaining({
          taskKind: "timer",
          queueAgeMs: 15,
          timerLagMs: 10,
        }),
      }),
    ]));
  });
});
