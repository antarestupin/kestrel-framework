import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import {
  EmbeddedWorkflowActivityTransport,
  type WorkflowActivityHandler,
} from "./activity_transport.js";
import { WorkflowClient } from "./client.js";
import {
  WorkflowActivityInfrastructureError,
  WorkflowActivityTimeoutError,
  WorkflowSignalTimeoutError,
} from "./errors.js";
import { WorkflowScheduler } from "./scheduler.js";
import { defineWorkflowSignal } from "./signal.js";
import { defineWorkflow } from "./workflow.js";

describe("durable workflow primitives", () => {
  it.each(["sync", "async"] as const)("runs typed Actions with retries and one stable idempotency key (%s)", async (mode) => {
    const action = defineAction({
      name: "example.retry",
      input: z.object({ value: mode === "async" ? z.string().refine(async () => true) : z.string() }),
      validation: { input: mode, output: mode },
      output: z.object({ value: mode === "async" ? z.string().refine(async () => true) : z.string() }),
      handler: (input) => input,
    });
    const workflow = defineWorkflow({
      name: "retry.run",
      input: action.inputSchema,
      validation: action.validation,
      output: action.outputSchema,
      handler: (input, context) => context.run(action, input, {
        retry: { maxAttempts: 2, initialDelay: { milliseconds: 0 } },
      }),
    });
    const keys: string[] = [];
    let attempts = 0;
    const runtime = createRuntime([workflow], (target) =>
      target === action.name
        ? (_payload, activity) => {
            keys.push(activity.idempotencyKey);
            attempts += 1;
            if (attempts === 1) {
              throw new WorkflowActivityInfrastructureError("temporary");
            }
            return { value: "done" };
          }
        : undefined);
    const handle = await runtime.client.start(workflow, { value: "input" });

    await runCycles(runtime.scheduler, 4);

    await expect(handle.result()).resolves.toEqual({ value: "done" });
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("surfaces activity deadlines as catchable typed failures", async () => {
    const action = defineAction({
      name: "example.deadline",
      output: z.null(),
      handler: () => null,
    });
    const workflow = defineWorkflow({
      name: "deadline.run",
      output: z.string(),
      handler: async (_input, context) => {
        try {
          await context.run(action, null, {
            startToCloseTimeout: { milliseconds: 0 },
          });
          return "completed";
        } catch (error) {
          return error instanceof WorkflowActivityTimeoutError
            ? error.name
            : "unexpected";
        }
      },
    });
    const runtime = createRuntime([workflow], () =>
      () => new Promise(() => undefined));
    const handle = await runtime.client.start(workflow, null);

    await runCycles(runtime.scheduler, 3);

    await expect(handle.result()).resolves.toBe("WorkflowActivityTimeoutError");
  });

  it("uses durable timers with virtual time", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const workflow = defineWorkflow({
      name: "timer.run",
      output: z.string(),
      handler: async (_input, context) => {
        await context.sleep({ hours: 5 });
        return "awake";
      },
    });
    const runtime = createRuntime([workflow], () => undefined, {
      adapterNow: () => now,
      schedulerNow: () => now.getTime(),
    });
    const handle = await runtime.client.start(workflow, null);

    await runtime.scheduler.runOnce();
    await expect(runtime.scheduler.runOnce()).resolves.toMatchObject({ reserved: 0 });
    now = new Date(now.getTime() + 5 * 3_600_000);
    await runCycles(runtime.scheduler, 2);

    await expect(handle.result()).resolves.toBe("awake");
  });

  it.each(["sync", "async"] as const)("consumes buffered signals once in durable arrival order (%s)", async (mode) => {
    const approval = defineWorkflowSignal({
      name: "example.approval",
      payload: z.object({ approved: mode === "async" ? z.boolean().refine(async () => true) : z.boolean() }),
      validation: { input: mode },
    });
    const workflow = defineWorkflow({
      name: "signal.run",
      signals: [approval],
      output: z.array(z.boolean()),
      handler: async (_input, context) => {
        const first = await context.waitForSignal(approval);
        const second = await context.waitForSignal(approval);
        return [first.approved, second.approved];
      },
    });
    const runtime = createRuntime([workflow], () => undefined);
    const handle = await runtime.client.start(workflow, null);
    await handle.signal(approval, { approved: true });
    await handle.signal(approval, { approved: false });

    await runCycles(runtime.scheduler, 3);

    await expect(handle.result()).resolves.toEqual([true, false]);
    expect(runtime.adapter.inspectSignals().map((signal) =>
      signal.consumedBySequence)).toEqual([0, 1]);
  });

  it("turns a signal deadline into a catchable durable timeout", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const approval = defineWorkflowSignal({
      name: "example.timeout",
      payload: z.boolean(),
    });
    const workflow = defineWorkflow({
      name: "signal-timeout.run",
      signals: [approval],
      output: z.string(),
      handler: async (_input, context) => {
        try {
          await context.waitForSignal(approval, { timeout: { seconds: 30 } });
          return "received";
        } catch (error) {
          return error instanceof WorkflowSignalTimeoutError
            ? error.name
            : "unexpected";
        }
      },
    });
    const runtime = createRuntime([workflow], () => undefined, {
      adapterNow: () => now,
      schedulerNow: () => now.getTime(),
    });
    const handle = await runtime.client.start(workflow, null);
    await runtime.scheduler.runOnce();
    now = new Date(now.getTime() + 30_000);

    await runCycles(runtime.scheduler, 2);

    await expect(handle.result()).resolves.toBe("WorkflowSignalTimeoutError");
  });

  it.each(["sync", "async"] as const)("starts child workflows and propagates their typed result (%s)", async (mode) => {
    const child = defineWorkflow({
      name: "child.run",
      input: z.object({ value: mode === "async" ? z.string().refine(async () => true) : z.string() }),
      validation: { input: mode, output: mode },
      output: mode === "async" ? z.string().refine(async () => true) : z.string(),
      handler: ({ value }) => value.toUpperCase(),
    });
    const parent = defineWorkflow({
      name: "parent.run",
      output: z.string(),
      handler: (_input, context) =>
        context.runChild(child, { value: "child" }),
    });
    const runtime = createRuntime([parent, child], () => undefined);
    const handle = await runtime.client.start(parent, null);

    await runCycles(runtime.scheduler, 3);

    await expect(handle.result()).resolves.toBe("CHILD");
    const childExecution = await runtime.adapter.get(`${handle.executionId}:0`);
    expect(childExecution).toMatchObject({
      parentExecutionId: handle.executionId,
      rootExecutionId: handle.executionId,
      status: "completed",
    });
  });

  it("runs durable compensation before cooperative cancellation completes", async () => {
    const effect = defineAction({
      name: "example.effect",
      output: z.null(),
      handler: () => null,
    });
    const compensate = defineAction({
      name: "example.compensate",
      output: z.null(),
      handler: () => null,
    });
    const workflow = defineWorkflow({
      name: "compensation.run",
      handler: async (_input, context) => {
        try {
          await context.run(effect, null);
        } catch (error) {
          await context.run(compensate, null);
          throw error;
        }
      },
    });
    const calls: string[] = [];
    const runtime = createRuntime([workflow], (target) =>
      (_payload, activity) => {
        calls.push(activity.target);
        return null;
      });
    const handle = await runtime.client.start(workflow, null);
    await runtime.scheduler.runOnce();
    await handle.cancel();

    await runCycles(runtime.scheduler, 3);

    await expect(handle.status()).resolves.toMatchObject({ status: "cancelled" });
    expect(calls).toEqual([compensate.name]);
  });

  it("cancels a workflow that has not reached a durable boundary", async () => {
    const workflow = defineWorkflow({
      name: "cancel-before-start.run",
      output: z.string(),
      handler: () => "should-not-complete",
    });
    const runtime = createRuntime([workflow], () => undefined);
    const handle = await runtime.client.start(workflow, null);

    await handle.cancel();
    await runtime.scheduler.runOnce();

    await expect(handle.status()).resolves.toMatchObject({ status: "cancelled" });
    expect(runtime.adapter.inspectTasks().filter((task) =>
      task.executionId === handle.executionId)).toEqual([]);
  });

  it("replays durable history before delivering cancellation after resume", async () => {
    const prepare = defineAction({
      name: "cancel-after-resume.prepare",
      output: z.null(),
      handler: () => null,
    });
    const workflow = defineWorkflow({
      name: "cancel-after-resume.run",
      handler: async (_input, context) => {
        await context.run(prepare, null);
        await context.sleep({ hours: 5 });
      },
    });
    const runtime = createRuntime([workflow], () => () => null);
    const handle = await runtime.client.start(workflow, null);

    // Persist a completed Activity followed by a pending timer before the
    // operator changes the execution state.
    await runCycles(runtime.scheduler, 3);
    await runtime.adapter.setPaused(handle.executionId, true);
    await handle.cancel();
    await runtime.scheduler.runOnce();

    await expect(handle.status()).resolves.toMatchObject({ status: "cancelled" });
    expect(runtime.adapter.inspectTasks().filter((task) =>
      task.executionId === handle.executionId)).toEqual([]);
  });

  it("captures nondeterministic values only on their first replay", async () => {
    let captures = 0;
    const workflow = defineWorkflow({
      name: "capture.run",
      output: z.number(),
      handler: (_input, context) => context.sideEffect(() => ++captures),
    });
    const runtime = createRuntime([workflow], () => undefined);
    const handle = await runtime.client.start(workflow, null);

    await runCycles(runtime.scheduler, 2);

    await expect(handle.result()).resolves.toBe(1);
    expect(captures).toBe(1);
  });

  it("fails instead of persisting an unserializable side effect", async () => {
    const workflow = defineWorkflow({
      name: "invalid-capture.run",
      handler: async (_input, context) => {
        await context.sideEffect(() => 1n);
      },
    });
    const runtime = createRuntime([workflow], () => undefined);
    const handle = await runtime.client.start(workflow, null);

    await runtime.scheduler.runOnce();

    await expect(handle.status()).resolves.toMatchObject({ status: "failed" });
    await expect(runtime.adapter.getHistory(handle.executionId))
      .resolves.toEqual([]);
  });

  it("aggregates independently scheduled durable activities with Promise.all", async () => {
    const first = defineAction({
      name: "parallel.first",
      output: z.string(),
      handler: () => "first",
    });
    const second = defineAction({
      name: "parallel.second",
      output: z.string(),
      handler: () => "second",
    });
    const workflow = defineWorkflow({
      name: "parallel.run",
      output: z.array(z.string()),
      handler: (_input, context) => Promise.all([
        context.run(first, null),
        context.run(second, null),
      ]),
    });
    const runtime = createRuntime([workflow], (target) =>
      target === first.name ? () => "first" : () => "second");
    const handle = await runtime.client.start(workflow, null);

    await runCycles(runtime.scheduler, 3);

    await expect(handle.result()).resolves.toEqual(["first", "second"]);
  });

  it("replays Promise.race from the persisted activity completion order", async () => {
    const first = defineAction({
      name: "race.first",
      output: z.string(),
      handler: () => "first",
    });
    const second = defineAction({
      name: "race.second",
      output: z.string(),
      handler: () => "second",
    });
    const workflow = defineWorkflow({
      name: "race.run",
      output: z.string(),
      handler: (_input, context) => Promise.race([
        context.run(first, null),
        context.run(second, null),
      ]),
    });
    const runtime = createRuntime([workflow], (target) =>
      target === first.name ? () => "first" : () => "second");
    const handle = await runtime.client.start(workflow, null);

    await runCycles(runtime.scheduler, 3);

    const history = await runtime.adapter.getHistory(handle.executionId);
    const firstCompletion = history.find((event) =>
      event.type === "command-completed");
    const winner = firstCompletion?.type === "command-completed"
      && firstCompletion.sequence === 0 ? "first" : "second";
    await expect(handle.result()).resolves.toBe(winner);
  });
});

function createRuntime(
  workflows: readonly ReturnType<typeof defineWorkflow>[],
  resolve: (target: string) => WorkflowActivityHandler | undefined,
  time: { adapterNow?: () => Date; schedulerNow?: () => number } = {},
) {
  const adapter = new MemoryWorkflowAdapter({
    ...(time.adapterNow === undefined ? {} : { now: time.adapterNow }),
  });
  const scheduler = new WorkflowScheduler(
    workflows,
    adapter,
    new EmbeddedWorkflowActivityTransport(resolve),
    {
      ...(time.schedulerNow === undefined ? {} : { now: time.schedulerNow }),
    },
  );
  return { adapter, scheduler, client: new WorkflowClient(adapter) };
}

async function runCycles(scheduler: WorkflowScheduler, count: number) {
  for (let index = 0; index < count; index += 1) {
    await scheduler.runOnce();
  }
}
