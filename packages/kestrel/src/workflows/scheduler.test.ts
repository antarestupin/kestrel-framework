import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { EmbeddedWorkflowActivityTransport } from "./activity_transport.js";
import type {
  CommitWorkflowActivationRequest,
  WorkflowTaskReservationRef,
} from "./adapter.js";
import { WorkflowClient } from "./client.js";
import { WorkflowScheduler } from "./scheduler.js";
import { defineWorkflow } from "./workflow.js";

describe("WorkflowScheduler", () => {
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

  it("blocks executions whose pinned version is no longer supported", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const oldWorkflow = defineWorkflow({
      name: "versioned.run",
      version: { current: 1 },
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
