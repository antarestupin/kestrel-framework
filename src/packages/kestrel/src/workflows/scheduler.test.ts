import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { EmbeddedWorkflowActivityTransport, type WorkflowActivityHandler } from "./activity_transport.js";
import type {
  CommitWorkflowActivationRequest,
  WorkflowTaskReservationRef,
} from "./adapter.js";
import { WorkflowClient } from "./client.js";
import { WorkflowScheduler, type WorkflowSchedulerOptions } from "./scheduler.js";
import { defineWorkflow } from "./workflow.js";
import { WorkflowActivityInfrastructureError } from "./errors.js";

describe("WorkflowScheduler", () => {
  it.each<[keyof WorkflowSchedulerOptions, number]>([
    ["batchSize", 0], ["idlePollMs", 1.5], ["leaseMs", -1], ["maxHistoryEvents", 0],
    ["completionBatchSize", 0], ["completionFlushIntervalMs", 0],
  ])("rejects an invalid %s", (name, value) => {
    const create = () => new WorkflowScheduler([], new MemoryWorkflowAdapter(),
      new EmbeddedWorkflowActivityTransport(() => undefined), { [name]: value });
    expect(create).toThrow(TypeError);
  });

  it("returns a task reserved while shutdown was beginning and prevents another reservation", async () => {
    const shutdown = new AbortController();
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "shutdown.admission", output: z.null(), handler: () => null });
    const scope = vi.fn();
    const reserve = adapter.reserveTasks.bind(adapter);
    const observed = vi.spyOn(adapter, "reserveTasks").mockImplementation(async (request) => {
      const reserved = await reserve(request);
      shutdown.abort();
      return reserved;
    });
    const release = vi.spyOn(adapter, "releaseTasks");
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      executionSignal: shutdown.signal, runInExecutionScope: scope,
    });
    await new WorkflowClient(adapter).start(workflow, null);

    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, stale: 1, completed: 0 });
    expect(scope).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith([{ taskId: expect.any(String), reservationToken: expect.any(String) }]);
    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 0, stale: 0, completed: 0 });
    expect(observed).toHaveBeenCalledOnce();
  });

  it("records the schedule-to-close deadline without entering the activity handler", async () => {
    let now = 5_000;
    const adapter = new MemoryWorkflowAdapter({ now: () => new Date(now) });
    const action = defineAction({ name: "deadline.schedule", handler: () => null });
    const workflow = defineWorkflow({ name: "deadline.workflow", output: z.null(), handler: (_input, context) =>
      context.run(action, null, { scheduleToCloseTimeout: { milliseconds: 50 } }) });
    const handler = vi.fn(() => null);
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => handler), {
      now: () => now, completionBatchSize: 1,
    });
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    await scheduler.runOnce();
    now += 50;

    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 1, stale: 0 });
    expect(handler).not.toHaveBeenCalled();
    expect(await adapter.getHistory(handle.executionId)).toMatchObject([
      { type: "command-scheduled" },
      { type: "command-completed", error: { name: "WorkflowActivityTimeoutError", message: expect.stringContaining("schedule-to-close") } },
    ]);
  });

  it("caps infrastructure retry delays and keeps the final failure durable", async () => {
    let now = 5_000;
    const adapter = new MemoryWorkflowAdapter({ now: () => new Date(now) });
    const action = defineAction({ name: "deadline.retry", handler: () => null });
    const workflow = defineWorkflow({ name: "deadline.retry-workflow", output: z.null(), handler: (_input, context) =>
      context.run(action, null, { retry: {
        maxAttempts: 3, initialDelay: { milliseconds: 20 }, backoffCoefficient: 3, maxDelay: { milliseconds: 35 },
      } }) });
    const handler = vi.fn<WorkflowActivityHandler>(() => { throw new WorkflowActivityInfrastructureError("transport offline"); });
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => handler), {
      now: () => now, completionBatchSize: 1,
    });
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    await scheduler.runOnce();
    for (const delay of [20, 35]) {
      await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 1, stale: 0 });
      now += delay - 1;
      await expect(scheduler.runOnce()).resolves.toMatchObject({ reserved: 0 });
      now++;
    }
    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 1 });
    expect(handler.mock.calls.map(([, attempt]) => attempt.attempt)).toEqual([1, 2, 3]);
    expect(await adapter.getHistory(handle.executionId)).toMatchObject([
      { type: "command-scheduled" }, { type: "command-completed", error: { name: "WorkflowActivityInfrastructureError" } },
    ]);
  });

  it.each(["missing", "wrong-task", "wrong-token", "owned"] as const)("checks a %s lease during execution-scope setup", async (ownership) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const adapter = new MemoryWorkflowAdapter();
    const action = defineAction({ name: "lease.protected", handler: () => null });
    const workflow = defineWorkflow({ name: "lease.workflow", output: z.null(), handler: (_input, context) => context.run(action, null) });
    const handler = vi.fn(() => null);
    const releaseScope = Promise.withResolvers<void>();
    const enteredScope = vi.fn();
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => handler), {
      leaseMs: 100,
      completionBatchSize: 1,
      async runInExecutionScope(_executionId, _operation, run, task) {
        if (task.kind === "activity") {
          enteredScope();
          await releaseScope.promise;
        }
        return run();
      },
    });
    const extend = vi.spyOn(adapter, "extendTaskLeases").mockImplementationOnce(async ([request]) => {
      if (request === undefined || ownership === "missing") return [];
      return [{
        taskId: ownership === "wrong-task" ? "another-task" : request.taskId,
        reservationToken: ownership === "wrong-token" ? "another-token" : request.reservationToken,
      }];
    });
    const finished = vi.fn();
    const failed = vi.fn();
    try {
      await new WorkflowClient(adapter).start(workflow, null);
      await scheduler.runOnce();
      void scheduler.runOnce().then(finished, failed);
      await vi.advanceTimersByTimeAsync(0);
      expect(enteredScope).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(50);
      expect(extend).toHaveBeenCalledOnce();
      releaseScope.resolve();
      await vi.advanceTimersByTimeAsync(0);
      const owned = ownership === "owned";
      expect(handler).toHaveBeenCalledTimes(owned ? 1 : 0);
      expect(finished).toHaveBeenCalledExactlyOnceWith({ reserved: 1, completed: owned ? 1 : 0, stale: owned ? 0 : 1 });
      expect(failed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { releaseScope.resolve(); vi.useRealTimers(); }
  });

  it("blocks a missing deployment definition and reports the lifecycle result", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start({ executionId: "missing-definition", workflowName: "missing.workflow", workflowVersion: 1, input: null });
    const record = vi.fn();
    const scheduler = new WorkflowScheduler([], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), { instrumentation: { record } });
    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 1, stale: 0 });
    await expect(adapter.get("missing-definition")).resolves.toMatchObject({ status: "blocked", error: { message: expect.stringContaining("missing.workflow") } });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: "lifecycle", outcome: "failure",
      data: expect.objectContaining({ executionId: "missing-definition", operation: "blocked" }) }));
  });

  it("counts an omitted activation snapshot as stale without opening a scope", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "snapshot.stale", handler: () => undefined });
    await new WorkflowClient(adapter).start(workflow, null);
    const load = vi.spyOn(adapter, "loadActivations").mockResolvedValue([]);
    const openScope = vi.fn();
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      runInExecutionScope: openScope,
    });

    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 0, stale: 1 });
    expect(load).toHaveBeenCalledExactlyOnceWith([{ taskId: expect.any(String), reservationToken: expect.any(String) }]);
    expect(openScope).not.toHaveBeenCalled();
  });

  it.each(["input", "output", "continued-input"] as const)("persists a %s validation failure as a terminal result", async (failure) => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "validation.workflow", input: z.string(), output: z.string(),
      handler: (_input, context) => {
        if (failure === "continued-input") return context.continueAsNew(false as never);
        return false as never;
      },
    });
    await adapter.start({ executionId: "invalid-validation", workflowName: workflow.name, workflowVersion: 1,
      input: failure === "input" ? false : "valid" });
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined));
    await expect(scheduler.runOnce()).resolves.toEqual({ reserved: 1, completed: 1, stale: 0 });
    await expect(adapter.get("invalid-validation")).resolves.toMatchObject({ status: "failed", error: { name: "ZodError" } });
    await expect(adapter.getHistoryArchives("invalid-validation")).resolves.toEqual([]);
  });

  it("releases all reservations if multiple execution scopes fail", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({ name: "batch.failure", handler: () => undefined });
    const client = new WorkflowClient(adapter);
    await client.start(workflow, null, { executionId: "first" });
    await client.start(workflow, null, { executionId: "second" });
    const failures = { first: new Error("first scope unavailable"), second: new Error("second scope unavailable") };
    const release = vi.spyOn(adapter, "releaseTasks");
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      runInExecutionScope: async (executionId) => { throw failures[executionId as keyof typeof failures]; },
    });
    await expect(scheduler.runOnce()).rejects.toMatchObject({ name: "AggregateError", errors: expect.arrayContaining(Object.values(failures)) });
    expect(release).toHaveBeenCalledTimes(2);
    expect(adapter.inspectTasks()).toHaveLength(2);
    expect(adapter.inspectTasks().map(({ reservationToken }) => reservationToken)).toEqual([undefined, undefined]);
  });

  it("executes replay activations and embedded activities to completion", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const uppercaseAction = defineAction({
      name: "example.uppercase",
      input: z.object({ value: z.string() }),
      output: z.object({ result: z.string() }),
      handler: ({ value }) => ({ result: value.toUpperCase() }),
    });
    const workflow = defineWorkflow({
      name: "example.run",
      input: z.object({ value: z.string() }),
      output: z.object({ result: z.string() }),
      handler: (input, context) => context.run(uppercaseAction, input),
    });
    const transport = new EmbeddedWorkflowActivityTransport((target) =>
      target === "example.uppercase"
        ? (payload) => ({
            result: (payload as { value: string }).value.toUpperCase(),
          })
        : undefined);
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      transport,
    );
    const client = new WorkflowClient(adapter);
    const handle = await client.start(workflow, { value: "hello" });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 1 });
    await expect(handle.status()).resolves.toMatchObject({ status: "waiting" });
    await scheduler.runOnce();
    await scheduler.runOnce();

    await expect(handle.status()).resolves.toMatchObject({ status: "completed" });
    await expect(handle.result()).resolves.toEqual({ result: "HELLO" });
    await expect(adapter.getHistory(handle.executionId)).resolves.toMatchObject([
      { type: "command-scheduled", target: "example.uppercase" },
      { type: "command-completed", result: { result: "HELLO" } },
    ]);
  });

  it("buffers concurrent activity completions into one adapter call", async () => {
    class TrackingAdapter extends MemoryWorkflowAdapter {
      public readonly completionBatchSizes: number[] = [];

      public override async completeActivities(
        requests: readonly import("./adapter.js").CompleteWorkflowActivityRequest[],
      ) {
        this.completionBatchSizes.push(requests.length);
        return super.completeActivities(requests);
      }
    }

    const adapter = new TrackingAdapter();
    const action = defineAction({
      name: "batch.activity",
      output: z.string(),
      handler: () => "done",
    });
    const workflow = defineWorkflow({
      name: "batch.completions",
      handler: async (_input, context) => {
        await Promise.all([
          context.run(action, null),
          context.run(action, null),
        ]);
      },
    });
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => () => "done"),
      { completionBatchSize: 2, completionFlushIntervalMs: 100 },
    );
    await new WorkflowClient(adapter).start(workflow, null);

    await scheduler.runOnce();
    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 2 });

    expect(adapter.completionBatchSizes).toEqual([2]);
  });

  it("buffers concurrent timer completions into one adapter call", async () => {
    class TrackingAdapter extends MemoryWorkflowAdapter {
      public readonly completionBatchSizes: number[] = [];

      public override async completeActivities(
        requests: readonly import("./adapter.js").CompleteWorkflowActivityRequest[],
      ) {
        this.completionBatchSizes.push(requests.length);
        return super.completeActivities(requests);
      }
    }

    const adapter = new TrackingAdapter();
    const workflow = defineWorkflow({
      name: "batch.timers",
      handler: async (_input, context) => {
        await Promise.all([
          context.sleep({ milliseconds: 0 }),
          context.sleep({ milliseconds: 0 }),
        ]);
      },
    });
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
      { completionBatchSize: 2, completionFlushIntervalMs: 100 },
    );
    await new WorkflowClient(adapter).start(workflow, null);

    await scheduler.runOnce();
    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 2 });

    expect(adapter.completionBatchSizes).toEqual([2]);
  });

  it.each([1, 3])("blocks an execution whose pinned version %s is outside the deployment range", async (version) => {
    const adapter = new MemoryWorkflowAdapter();
    const oldWorkflow = defineWorkflow({
      name: "versioned.run",
      version: { current: version },
      handler: () => undefined,
    });
    const client = new WorkflowClient(adapter);
    const handle = await client.start(oldWorkflow, null);
    const currentWorkflow = defineWorkflow({
      name: "versioned.run",
      version: { current: 2, supportedFrom: 2 },
      handler: () => undefined,
    });
    const scheduler = new WorkflowScheduler(
      [currentWorkflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
    );

    await scheduler.runOnce();

    await expect(adapter.get(handle.executionId)).resolves.toMatchObject({
      status: "blocked",
      error: { name: "WorkflowExecutionVersionUnsupportedError" },
    });
  });

  it("runs every task inside the injected execution boundary", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({
      name: "scope.run",
      handler: () => undefined,
    });
    const calls: string[] = [];
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
      {
        runInExecutionScope: async (executionId, operation, run) => {
          calls.push(`${executionId}:${operation}`);
          return run();
        },
      },
    );
    const handle = await new WorkflowClient(adapter).start(workflow, null);

    await scheduler.runOnce();

    expect(calls).toEqual([`${handle.executionId}:workflow.activate`]);
  });

  it("loads reserved workflow snapshots in one batch before opening scopes", async () => {
    class TrackingAdapter extends MemoryWorkflowAdapter {
      public readonly batchSizes: number[] = [];

      public snapshotsLoaded = false;

      public override async loadActivations(
        reservations: readonly WorkflowTaskReservationRef[],
      ) {
        this.batchSizes.push(reservations.length);
        const loaded = await super.loadActivations(reservations);
        this.snapshotsLoaded = true;
        return loaded;
      }
    }

    const adapter = new TrackingAdapter();
    const workflow = defineWorkflow({
      name: "batch.run",
      handler: () => undefined,
    });
    const scopeStates: boolean[] = [];
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
      {
        runInExecutionScope: async (_executionId, _operation, run) => {
          scopeStates.push(adapter.snapshotsLoaded);
          return run();
        },
      },
    );
    const client = new WorkflowClient(adapter);
    await client.start(workflow, null, { executionId: "batch-1" });
    await client.start(workflow, null, { executionId: "batch-2" });

    await expect(scheduler.runOnce()).resolves.toEqual({
      reserved: 2,
      completed: 2,
      stale: 0,
    });
    expect(adapter.batchSizes).toEqual([2]);
    expect(scopeStates).toEqual([true, true]);
  });

  it("releases an activation when a signal advances its loaded revision", async () => {
    class RacingSignalAdapter extends MemoryWorkflowAdapter {
      private injectSignal = true;

      public override async loadActivations(
        reservations: readonly WorkflowTaskReservationRef[],
      ) {
        const loaded = await super.loadActivations(reservations);
        const snapshot = loaded[0]?.snapshot;

        if (snapshot !== undefined && this.injectSignal) {
          this.injectSignal = false;
          await this.sendSignal({
            executionId: snapshot.executionId,
            workflowName: snapshot.workflowName,
            signalName: "example.race",
            payload: null,
          });
        }

        return loaded;
      }
    }

    const adapter = new RacingSignalAdapter();
    const workflow = defineWorkflow({
      name: "race.run",
      handler: () => undefined,
    });
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
    );
    const handle = await new WorkflowClient(adapter).start(workflow, null);

    await expect(scheduler.runOnce()).resolves.toEqual({
      reserved: 1,
      completed: 0,
      stale: 1,
    });
    await scheduler.runOnce();

    await expect(handle.status()).resolves.toMatchObject({ status: "completed" });
    await expect(adapter.getHistory(handle.executionId)).resolves.toMatchObject([
      { type: "signal-received", name: "example.race" },
    ]);
  });

  it("recovers a task after an interruption before its durable commit", async () => {
    class InterruptingAdapter extends MemoryWorkflowAdapter {
      private interrupt = true;

      public override async commitActivation(
        request: CommitWorkflowActivationRequest,
      ): Promise<boolean> {
        if (this.interrupt) {
          this.interrupt = false;
          throw new Error("Injected interruption");
        }

        return super.commitActivation(request);
      }
    }

    const adapter = new InterruptingAdapter();
    const workflow = defineWorkflow({
      name: "interruption.run",
      handler: () => undefined,
    });
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
    );
    const handle = await new WorkflowClient(adapter).start(workflow, null);

    await expect(scheduler.runOnce()).rejects.toThrow("Injected interruption");
    await expect(scheduler.runOnce()).resolves.toMatchObject({ completed: 1 });
    await expect(handle.status()).resolves.toMatchObject({ status: "completed" });
  });

  it("allows only one scheduler to reserve a workflow activation", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({
      name: "concurrent.run",
      handler: () => undefined,
    });
    const transport = new EmbeddedWorkflowActivityTransport(() => undefined);
    const first = new WorkflowScheduler([workflow], adapter, transport);
    const second = new WorkflowScheduler([workflow], adapter, transport);
    const handle = await new WorkflowClient(adapter).start(workflow, null);

    const cycles = await Promise.all([first.runOnce(), second.runOnce()]);

    expect(cycles.reduce((total, cycle) => total + cycle.reserved, 0)).toBe(1);
    await expect(handle.status()).resolves.toMatchObject({ status: "completed" });
  });

  it("blocks replay before an oversized history can continue growing", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const action = defineAction({
      name: "history.activity",
      output: z.null(),
      handler: () => null,
    });
    const workflow = defineWorkflow({
      name: "history.run",
      handler: async (_input, context) => {
        await context.run(action, null);
      },
    });
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => () => null),
      { maxHistoryEvents: 1 },
    );
    const handle = await new WorkflowClient(adapter).start(workflow, null);

    await scheduler.runOnce();
    await scheduler.runOnce();
    await scheduler.runOnce();

    await expect(handle.status()).resolves.toMatchObject({
      status: "blocked",
      error: { name: "WorkflowHistoryLimitExceededError" },
    });
  });

  it("continues as new under the same identity with a fresh archived generation", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const workflow = defineWorkflow({
      name: "generation.loop",
      version: { current: 2, supportedFrom: 1 },
      input: z.object({ remaining: z.number().int().nonnegative() }),
      output: z.object({ generation: z.number().int() }),
      handler: async ({ remaining }, context) => {
        if (remaining > 0) {
          await context.continueAsNew({ remaining: remaining - 1 });
        }
        return { generation: context.generation };
      },
    });
    const scheduler = new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
    );
    const handle = await new WorkflowClient(adapter).start(
      workflow,
      { remaining: 2 },
      { executionId: "generation-loop" },
    );

    await scheduler.runOnce();
    await expect(handle.status()).resolves.toMatchObject({
      executionId: "generation-loop",
      workflowVersion: 2,
      historyGeneration: 2,
      input: { remaining: 1 },
      status: "queued",
    });
    await scheduler.runOnce();
    await scheduler.runOnce();

    await expect(handle.status()).resolves.toMatchObject({ status: "completed", historyGeneration: 3 });
    await expect(handle.result()).resolves.toEqual({ generation: 3 });
    await expect(adapter.getHistoryArchives("generation-loop"))
      .resolves.toMatchObject([
        { historyGeneration: 1, input: { remaining: 2 }, history: [] },
        { historyGeneration: 2, input: { remaining: 1 }, history: [] },
      ]);
    // A retry of the original start request remains idempotent even though the
    // current generation input has changed twice.
    await expect(new WorkflowClient(adapter).start(
      workflow,
      { remaining: 2 },
      { executionId: "generation-loop" },
    )).resolves.toMatchObject({ executionId: "generation-loop" });
  });
});
