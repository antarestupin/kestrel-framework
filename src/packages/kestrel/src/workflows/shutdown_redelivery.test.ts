import { expect, it } from "vitest";
import { defineAction } from "../actions/index.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { EmbeddedWorkflowActivityTransport } from "./activity_transport.js";
import { WorkflowClient } from "./client.js";
import { WorkflowScheduler } from "./scheduler.js";
import { defineWorkflow } from "./workflow.js";

it("redelivers an abandoned activity, fences its late completion and preserves a target-side idempotent effect", async () => {
  let now = new Date("2026-10-16T00:00:00Z");
  const adapter = new MemoryWorkflowAdapter({ now: () => now });
  const action = defineAction({ name: "shutdown.effect", handler: () => null });
  const workflow = defineWorkflow({ name: "shutdown.redelivery", handler: async (_input, context) => { await context.run(action, null); } });
  const effects = new Set<string>();
  let attempts = 0;
  let started!: () => void;
  let release!: () => void;
  const activityStarted = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const transport = new EmbeddedWorkflowActivityTransport(() => async (_payload, activity) => {
    attempts++;
    // A target-owned key spans reservation generations and protects business effects.
    effects.add(`${activity.executionId}:${activity.sequence}`);
    if (attempts === 1) { started(); await blocked; }
    return null;
  });
  const cancellation = new AbortController();
  const first = new WorkflowScheduler([workflow], adapter, transport, {
    leaseMs: 100, completionBatchSize: 1, executionSignal: cancellation.signal,
  });
  const successor = new WorkflowScheduler([workflow], adapter, transport, { leaseMs: 100, completionBatchSize: 1 });
  const handle = await new WorkflowClient(adapter).start(workflow, null);
  await first.runOnce();
  const abandoned = first.runOnce();
  try {
    await activityStarted;
    cancellation.abort();
    now = new Date(now.getTime() + 101);
    expect(await successor.runOnce()).toMatchObject({ completed: 1 });
    release();
    expect(await abandoned).toMatchObject({ stale: 1, completed: 0 });
    await successor.runOnce();
    expect(await handle.status()).toMatchObject({ status: "completed" });
    expect(attempts).toBe(2);
    expect(effects.size).toBe(1);
  } finally { cancellation.abort(); release(); await abandoned; }
});
