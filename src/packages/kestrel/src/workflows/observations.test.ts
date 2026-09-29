import { describe, expect, it, vi } from "vitest";

import { EmbeddedWorkflowActivityTransport } from "./activity_transport.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { WorkflowClient } from "./client.js";
import type { WorkflowInstrumentationEvent } from "./observations.js";
import { WorkflowScheduler } from "./scheduler.js";
import { defineWorkflow } from "./workflow.js";

describe("workflow instrumentation", () => {
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
