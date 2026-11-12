import { setImmediate } from "node:timers/promises";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { EmbeddedWorkflowActivityTransport } from "./activity_transport.js";
import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { WorkflowClient } from "./client.js";
import { DurableWorkflowExecutionContext, workflowDurationToMilliseconds } from "./context.js";
import {
  serializeWorkflowError,
  WorkflowActivityInfrastructureError,
  WorkflowActivityTimeoutError,
  WorkflowCancellationError,
  WorkflowInvalidSuspensionError,
  WorkflowSignalTimeoutError,
} from "./errors.js";
import type { WorkflowActivationSnapshot } from "./history.js";
import { WorkflowReplayer } from "./replayer.js";
import { WorkflowScheduler } from "./scheduler.js";
import { jsonWorkflowPayloadCodec } from "./serialization.js";
import { defineWorkflowSignal } from "./signal.js";
import { defineWorkflow } from "./workflow.js";

const baseSnapshot: WorkflowActivationSnapshot = {
  executionId: "execution-1",
  workflowName: "example.run",
  workflowVersion: 2,
  historyGeneration: 1,
  input: { value: "input" },
  revision: 0,
  history: [],
  cancellationRequested: false,
};

describe("WorkflowReplayer", () => {
  it("settles after the handler's completed preparation is removed from the pending set", async () => {
    let replayTurns = 0;
    const replayer = new WorkflowReplayer({ yieldExecution: () => {
      // Settled preparation must not make an otherwise completed activation keep yielding.
      expect(++replayTurns).toBeLessThan(8);
      return Promise.resolve();
    } });
    const preparation = Promise.withResolvers<string>();
    const result = replayer.replay(baseSnapshot, (_input, context) => {
      const prepared = context.prepare!(() => preparation.promise);
      preparation.resolve("ready");
      return prepared;
    });

    await expect(result).resolves.toEqual({ status: "completed", output: "ready", commands: [] });
  });

  it("replays a failed capture once and resumes the handler's durable fallback", async () => {
    const capture = vi.fn(() => { throw new WorkflowActivityInfrastructureError("capture failed"); });
    const workflow = defineWorkflow({ name: "captured-failure", output: z.string(),
      handler: async (_input, context) => {
        try {
          await context.sideEffect(capture);
          return "unexpected capture success";
        } catch (error) {
          if (!(error instanceof WorkflowActivityInfrastructureError)) throw error;
          await context.sleep({ milliseconds: 0 });
          return error.message;
        }
      },
    });
    const adapter = new MemoryWorkflowAdapter();
    let replayTurns = 0;
    const replayer = new WorkflowReplayer({ yieldExecution: () => {
      // Replay must settle after the recorded capture and timer are delivered.
      expect(++replayTurns).toBeLessThan(25);
      return setImmediate();
    } });
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), { replayer });
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    await scheduler.runOnce();
    expect(await adapter.getHistory(handle.executionId)).toContainEqual(expect.objectContaining({
      type: "command-completed", sequence: 0, error: { name: "WorkflowActivityInfrastructureError", message: "capture failed", stack: expect.any(String) },
    }));
    for (let turn = 0; turn < 4; turn++) await scheduler.runOnce();
    await expect(handle.status()).resolves.toMatchObject({ status: "completed" });
    await expect(handle.result()).resolves.toBe("capture failed");
    expect(capture).toHaveBeenCalledOnce();
  });

  it("fails an invalid capture encoding without writing a command or its placeholder", async () => {
    const failure = new Error("custom codec rejected the capture");
    const workflow = defineWorkflow({ name: "invalid-capture-codec",
      handler: async (_input, context) => { await context.sideEffect(() => "unsupported"); },
    });
    const adapter = new MemoryWorkflowAdapter();
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      payloadCodec: {
        encode: async () => { throw failure; },
        decode: (value) => jsonWorkflowPayloadCodec.decode(value),
      },
    });
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    await scheduler.runOnce();
    await expect(handle.status()).resolves.toMatchObject({ status: "failed", error: { message: failure.message } });
    await expect(adapter.getHistory(handle.executionId)).resolves.toEqual([]);
  });

  it("does not commit an invalid capture placeholder when the handler catches its encoding failure", async () => {
    const failure = new Error("custom codec rejected the capture");
    const caught = vi.fn();
    const workflow = defineWorkflow({ name: "caught-capture-encoding",
      handler: async (_input, context) => {
        try {
          await context.sideEffect(() => "unencodable");
        } catch (error) {
          caught(error);
          if (error !== failure) throw error;
          await context.sleep({ milliseconds: 0 });
        }
      },
    });
    const adapter = new MemoryWorkflowAdapter();
    const scheduler = new WorkflowScheduler([workflow], adapter, new EmbeddedWorkflowActivityTransport(() => undefined), {
      payloadCodec: {
        encode: () => { throw failure; },
        decode: (value) => jsonWorkflowPayloadCodec.decode(value),
      },
    });
    const handle = await new WorkflowClient(adapter).start(workflow, null);
    await scheduler.runOnce();
    await expect(handle.status()).resolves.toMatchObject({ status: "failed", error: { message: failure.message } });
    await expect(adapter.getHistory(handle.executionId)).resolves.toEqual([]);
    expect(caught).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("reserves the first continuation while its asynchronous encoding is pending", async () => {
    const encoded = Promise.withResolvers<number>();
    const encode = vi.fn((value: unknown) => value === 1 ? encoded.promise : jsonWorkflowPayloadCodec.encode(value));
    const replayer = new WorkflowReplayer();
    const replaying = replayer.replay(baseSnapshot, async (_input, replay) => {
      const context = new DurableWorkflowExecutionContext(replay, {
        codec: { encode, decode: jsonWorkflowPayloadCodec.decode },
        cancellationRequested: false, createUuid: () => "unused", now: () => 0, signals: [],
      });
      const first = context.continueAsNew(1);
      const second = context.continueAsNew(2);
      const outcomes = await Promise.allSettled([first, second]);
      return { outcomes, input: context.continueAsNewInput };
    });
    try {
      await setImmediate();
    } finally {
      encoded.resolve(1);
    }
    expect(await replaying).toMatchObject({
      status: "completed",
      output: { input: 1, outcomes: [
        { status: "rejected", reason: { name: "WorkflowContinueAsNewInterrupt" } },
        { status: "rejected", reason: new TypeError("A workflow activation can continue as new only once.") },
      ] },
    });
    expect(encode).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("rejects an empty explicit child identity before staging an adapter command", async () => {
    const child = defineWorkflow({ name: "invalid.identity-child", handler: () => undefined });
    const result = await new WorkflowReplayer().replay(baseSnapshot, (_input, replay) =>
      new DurableWorkflowExecutionContext(replay, {
        codec: jsonWorkflowPayloadCodec, cancellationRequested: false,
        createUuid: () => "unused", now: () => 0, signals: [],
      }).runChild(child, null, { executionId: "" }));
    expect(result).toEqual({
      status: "failed", error: new TypeError("Workflow execution IDs cannot be empty."), commands: [],
    });
  });

  it("lets the handler recover from a continuation input that could not be encoded", async () => {
    const encodeFailure = new Error("Continuation input rejected");
    const result = await new WorkflowReplayer().replay(baseSnapshot, async (_input, replay) => {
      const context = new DurableWorkflowExecutionContext(replay, {
        codec: {
          encode: (value) => { if (value === 1) throw encodeFailure; return jsonWorkflowPayloadCodec.encode(value); },
          decode: jsonWorkflowPayloadCodec.decode,
        },
        cancellationRequested: false, createUuid: () => "unused", now: () => 0, signals: [],
      });
      await expect(context.continueAsNew(1)).rejects.toBe(encodeFailure);
      await expect(context.continueAsNew(2)).rejects.toMatchObject({
        name: "WorkflowContinueAsNewInterrupt", message: "Workflow requested continue-as-new.",
      });
      return context.continueAsNewInput;
    });
    expect(result).toEqual({ status: "completed", output: 2, commands: [] });
  });

  it.each([
    ["", "target"], ["activity", ""],
  ])("rejects an empty durable command identity %s/%s", async (kind, target) => {
    const result = await new WorkflowReplayer().replay(baseSnapshot, (_input, context) =>
      context.command(kind, target, null));
    expect(result).toEqual({
      status: "failed", error: new TypeError("Workflow command kind and target must not be empty."), commands: [],
    });
  });

  it.each([
    { name: "WorkflowActivityTimeoutError", type: WorkflowActivityTimeoutError,
      fallback: { executionId: "unknown", sequence: -1, timeoutKind: "start-to-close" } },
    { name: "WorkflowCancellationError", type: WorkflowCancellationError, fallback: { executionId: "unknown" } },
    { name: "WorkflowSignalTimeoutError", type: WorkflowSignalTimeoutError,
      fallback: { executionId: "unknown", signalName: "unknown" } },
  ])("restores the typed legacy $name even without detail metadata", async ({ name, type, fallback }) => {
    const error = { name, message: "Original durable failure", stack: "Original durable stack" };
    const result = await new WorkflowReplayer().replay({
      ...baseSnapshot, revision: 2, history: [scheduled(0, "recorded"), {
        type: "command-completed", eventIndex: 1, sequence: 0, completionOrder: 0,
        error, occurredAt: new Date(1),
      }],
    }, (_input, context) => context.command("activity", "recorded", null));
    expect(result).toMatchObject({ status: "failed", error: { ...error, ...fallback }, commands: [] });
    expect(result.status === "failed" && result.error).toBeInstanceOf(type);
  });

  it("keeps the native stack when a historical error has no saved stack", async () => {
    const result = await new WorkflowReplayer().replay({
      ...baseSnapshot, revision: 2, history: [scheduled(0, "recorded"), {
        type: "command-completed", eventIndex: 1, sequence: 0, completionOrder: 0,
        error: { name: "HistoricalError", message: "Recorded failure" }, occurredAt: new Date(1),
      }],
    }, (_input, context) => context.command("activity", "recorded", null));
    expect(result).toMatchObject({
      status: "failed", error: { name: "HistoricalError", message: "Recorded failure", stack: expect.any(String) },
    });
    expect(result.status === "failed" && result.error).not.toBeInstanceOf(WorkflowSignalTimeoutError);
  });

  it("waits for the actual encoded capture before returning a staged command", async () => {
    const encoded = Promise.withResolvers<string>();
    const replayer = new WorkflowReplayer();
    const replaying = replayer.replay(baseSnapshot, (_input, workflow) =>
      workflow.capture("delayed-encoding", () => encoded.promise));
    let finished = false;
    void replaying.then(() => { finished = true; }, () => { finished = true; });
    try {
      await setImmediate();
      expect(finished).toBe(false);
    } finally {
      encoded.resolve("durable value");
      await replaying;
    }
    expect(await replaying).toEqual({
      status: "waiting",
      commands: [{ sequence: 0, kind: "capture", target: "delayed-encoding", payload: "durable value" }],
    });
  });

  it("treats an asynchronous activity schema as owned preparation during replay", async () => {
    const schema = Promise.withResolvers<boolean>();
    const action = defineAction({
      name: "activity.delayed-input",
      input: z.string().refine(() => schema.promise),
      validation: { input: "async" },
      output: z.string(),
      handler: (input) => input,
    });
    const replaying = new WorkflowReplayer().replay(baseSnapshot, (_input, workflow) =>
      new DurableWorkflowExecutionContext(workflow, {
        codec: jsonWorkflowPayloadCodec, cancellationRequested: false,
        createUuid: () => "unused", now: () => 0, signals: [],
      }).run(action, "valid input"));
    let finished = false;
    void replaying.then(() => { finished = true; }, () => { finished = true; });
    try {
      await setImmediate();
      expect(finished).toBe(false);
    } finally {
      schema.resolve(true);
      await replaying;
    }
    expect(await replaying).toMatchObject({
      status: "waiting",
      commands: [{ sequence: 0, kind: "activity", target: action.name, payload: { input: "valid input" } }],
    });
  });

  it.each(["first", "second"] as const)("keeps the existing parallel command order while the %s encoder is pending", async (delayed) => {
    const encoding = Promise.withResolvers<string>();
    const encode = vi.fn((value: unknown) => value === delayed ? encoding.promise : jsonWorkflowPayloadCodec.encode(value));
    const yieldExecution = vi.fn(() => setImmediate());
    const action = defineAction({ name: "activity.ordered", input: z.string(), output: z.string(), handler: (input) => input });
    const replaying = new WorkflowReplayer({ yieldExecution }).replay(baseSnapshot, (_input, workflow) => {
      const context = new DurableWorkflowExecutionContext(workflow, {
        codec: { encode, decode: (value) => value }, cancellationRequested: false,
        createUuid: () => "unused", now: () => 0, signals: [],
      });
      return Promise.all([
        context.run(action, "first", {
          label: "custom retry", retry: { maxAttempts: 3, backoffCoefficient: 1.5, initialDelay: { seconds: 2 }, maxDelay: { minutes: 1 } },
          scheduleToCloseTimeout: { hours: 2 }, startToCloseTimeout: { milliseconds: 25 },
        }),
        context.run(action, "second"),
      ]);
    });
    try {
      await setImmediate();
      expect(encode.mock.calls).toEqual([["first"], ["second"]]);
      await setImmediate();
      expect(yieldExecution).toHaveBeenCalledTimes(1);
    } finally {
      encoding.resolve(delayed);
      await replaying;
    }
    const commands = [
      { kind: "activity", target: action.name, payload: { input: "first", options: {
        maxAttempts: 3, backoffCoefficient: 1.5, initialDelayMs: 2_000, maxDelayMs: 60_000,
        scheduleToCloseTimeoutMs: 7_200_000, startToCloseTimeoutMs: 25, label: "custom retry",
      } } },
      { kind: "activity", target: action.name, payload: { input: "second", options: {
        maxAttempts: 1, backoffCoefficient: 2, initialDelayMs: 1_000,
      } } },
    ];
    if (delayed === "first") commands.reverse();
    expect(await replaying).toEqual({ status: "waiting", commands: commands.map((command, sequence) => ({ ...command, sequence })) });
  });

  it("waits for decoding a stored capture without running the original callback again", async () => {
    const decoded = Promise.withResolvers<string>();
    const capture = vi.fn(() => "unexpected new value");
    const decode = vi.fn(() => decoded.promise);
    const replaying = new WorkflowReplayer().replay({ ...baseSnapshot, revision: 2, history: [
      { ...scheduled(0, "side-effect"), kind: "capture", payload: "recorded" },
      completed(0, 0, "recorded", 1),
    ] }, (_input, workflow) => new DurableWorkflowExecutionContext(workflow, {
      codec: { encode: (value) => jsonWorkflowPayloadCodec.encode(value), decode }, cancellationRequested: false,
      createUuid: () => "unused", now: () => 0, signals: [],
    }).sideEffect(capture));
    try {
      await setImmediate();
      expect(decode).toHaveBeenCalledExactlyOnceWith("recorded");
      expect(capture).not.toHaveBeenCalled();
    } finally {
      decoded.resolve("decoded");
      await replaying;
    }
    expect(await replaying).toEqual({ status: "completed", output: "decoded", commands: [] });
  });

  it("propagates a rejected preparation to handler code without recording an activity", async () => {
    const error = new Error("encode failed");
    const action = defineAction({ name: "activity.unencodable", output: z.null(), handler: () => null });
    const result = await new WorkflowReplayer().replay(baseSnapshot, async (_input, workflow) => {
      const context = new DurableWorkflowExecutionContext(workflow, {
        codec: { encode: async () => { throw error; }, decode: (value) => value }, cancellationRequested: false,
        createUuid: () => "unused", now: () => 0, signals: [],
      });
      try {
        return await context.run(action, null);
      } catch (cause) {
        return cause;
      }
    });
    expect(result).toEqual({ status: "completed", output: error, commands: [] });
  });

  it("blocks a handler suspended on a promise outside the workflow runtime", async () => {
    const result = await new WorkflowReplayer().replay(baseSnapshot, () => new Promise<string>(() => undefined));
    expect(result).toEqual({ status: "blocked", error: expect.any(WorkflowInvalidSuspensionError), commands: [] });
  });

  it.each([false, true])("blocks when recorded commands are removed (first command retained=%s)", async (kept) => {
    const result = await new WorkflowReplayer().replay({ ...baseSnapshot, revision: 2, history: [scheduled(0, "first"), scheduled(1, "removed", 1)] },
      (_input, workflow) => kept ? workflow.command("activity", "first", null) : null);
    expect(result).toMatchObject({ status: "blocked", error: { name: "WorkflowNondeterminismError", sequence: kept ? 1 : 0 }, commands: [] });
  });

  it("reconstructs completed and parallel pending commands before delivering cancellation", async () => {
    const cancellation = new WorkflowCancellationError(baseSnapshot.executionId);
    const reached: boolean[] = [];
    const result = await new WorkflowReplayer().replay({ ...baseSnapshot, cancellationRequested: true, revision: 6, history: [
      scheduled(0, "completed", 0), completed(0, 0, "completed", 1),
      scheduled(2, "second-pending", 3), scheduled(1, "first-pending", 2),
      { type: "cancellation-requested", eventIndex: 4, occurredAt: new Date(4) },
      completed(2, 1, "too late", 5),
    ] }, async (_input, workflow) => {
      const command = (name: string) => {
        reached.push(workflow.canDeliverCancellation);
        return workflow.command("activity", name, null, workflow.canDeliverCancellation ? cancellation : undefined);
      };
      await command("completed");
      try {
        await Promise.all([command("first-pending"), command("second-pending")]);
      } catch (error) {
        if (error !== cancellation) throw error;
        await workflow.command("activity", "compensate", null);
      }
    });
    expect(reached).toEqual([false, false, true]);
    expect(result).toEqual({ status: "waiting", commands: [{ sequence: 3, kind: "activity", target: "compensate", payload: null }] });
  });

  it("does not mistake a consumed completed command for a durable suspension", async () => {
    const result = await new WorkflowReplayer().replay({
      ...baseSnapshot, revision: 2,
      history: [scheduled(0, "complete"), completed(0, 0, "finished", 1)],
    }, async (_input, replay) => {
      await replay.command("activity", "complete", null);
      return new Promise(() => undefined);
    });
    expect(result).toMatchObject({
      status: "blocked", error: { name: "WorkflowInvalidSuspensionError" }, commands: [],
    });
  });

  it("flushes a recorded completion needed by a pending preparation", async () => {
    const completedReplay = vi.fn();
    const rejectedReplay = vi.fn();
    const replay = new WorkflowReplayer({ yieldExecution: () => Promise.resolve() });
    void replay.replay({
      ...baseSnapshot, revision: 4,
      history: [scheduled(0, "first"), completed(0, 0, "one", 1),
        scheduled(1, "second", 2), completed(1, 1, "two", 3)],
    }, async (_input, context) => {
      await context.command("activity", "first", null);
      const second = context.command("activity", "second", null);
      return context.prepare!(() => second);
    }).then(completedReplay, rejectedReplay);
    await setImmediate();
    expect(completedReplay).toHaveBeenCalledExactlyOnceWith({ status: "completed", output: "two", commands: [] });
    expect(rejectedReplay).not.toHaveBeenCalled();
  });

  it("propagates an unexpected replay scheduling failure", async () => {
    const failure = new Error("Replay scheduling unavailable");
    const replay = new WorkflowReplayer({ yieldExecution: () => Promise.reject(failure) });
    await expect(replay.replay(baseSnapshot, () => new Promise(() => undefined))).rejects.toBe(failure);
  });

  it("delivers cancellation at the next boundary when earlier durable commands are already complete", async () => {
    const cancellation = new WorkflowCancellationError(baseSnapshot.executionId);
    const result = await new WorkflowReplayer().replay({
      ...baseSnapshot, cancellationRequested: true, revision: 3,
      history: [scheduled(0, "completed"), completed(0, 0, "finished", 1),
        { type: "cancellation-requested", eventIndex: 2, occurredAt: new Date(2) }],
    }, async (_input, replay) => {
      expect(replay.canDeliverCancellation).toBe(false);
      await expect(replay.command("activity", "completed", null)).resolves.toBe("finished");
      expect(replay.canDeliverCancellation).toBe(true);
      return replay.command("activity", "new", null, cancellation);
    });
    expect(result).toEqual({ status: "failed", error: cancellation, commands: [] });
  });

  it.each(["existing capture", "new capture", "new command"] as const)(
    "injects cancellation at the %s boundary without staging work", async (boundary) => {
      const cancellation = new WorkflowCancellationError(baseSnapshot.executionId);
      const history = boundary === "existing capture"
        ? [{ ...scheduled(0, "capture"), kind: "capture" }]
        : [];
      const snapshot = {
        ...baseSnapshot,
        cancellationRequested: true,
        revision: history.length + 1,
        history: [...history, { type: "cancellation-requested" as const, eventIndex: history.length, occurredAt: new Date(1) }],
      };
      const capture = vi.fn(() => "a side effect must not run after cancellation");

      const result = await new WorkflowReplayer().replay(snapshot, (_input, context) => {
        expect(context.canDeliverCancellation).toBe(true);
        return boundary === "new command"
          ? context.command("activity", "read", null, cancellation)
          : context.capture("capture", capture, cancellation);
      });

      expect(result).toEqual({ status: "failed", error: cancellation, commands: [] });
      expect(capture).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: "capture", expectedTarget: "original" },
    { kind: "activity", expectedTarget: "renamed" },
  ])("blocks replay when a capture replaces a recorded $kind with a different identity", async ({ kind, expectedTarget }) => {
    const capture = vi.fn(() => "different");
    const snapshot = {
      ...baseSnapshot,
      revision: 1,
      history: [{ ...scheduled(0, expectedTarget), kind }],
    };

    // Replay must not silently rerun a side effect after its identity changes.
    await expect(new WorkflowReplayer().replay(snapshot, (_input, context) =>
      context.capture("renamed", capture))).resolves.toMatchObject({
      status: "blocked",
      error: { name: "WorkflowNondeterminismError", sequence: 0, expectedKind: kind, actualKind: "capture" },
      commands: [],
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures clock and UUID values with stable targets", async () => {
    const result = await new WorkflowReplayer().replay(baseSnapshot, (_input, workflow) => {
      const context = new DurableWorkflowExecutionContext(workflow, {
        codec: jsonWorkflowPayloadCodec, cancellationRequested: false,
        createUuid: () => "injected-uuid", now: () => 42, signals: [],
      });
      return Promise.all([context.now(), context.uuid()]);
    });
    expect(result).toEqual({ status: "waiting", commands: [
      { sequence: 0, kind: "capture", target: "now", payload: 42 },
      { sequence: 1, kind: "capture", target: "uuid", payload: "injected-uuid" },
    ] });
  });

  it("validates total duration and includes whole days", () => {
    expect(workflowDurationToMilliseconds({ days: 2, milliseconds: 5 })).toBe(172_800_005);
    for (const milliseconds of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => workflowDurationToMilliseconds({ milliseconds })).toThrow(
        "Workflow durations must resolve to safe non-negative milliseconds.",
      );
    }
  });

  it("passes an explicit child identity and validated concurrency key through replay", async () => {
    const child = defineWorkflow({ name: "child-admitted", input: z.string().transform((key) => key.toUpperCase()),
      concurrency: { keyed: { key: (key) => key, conflict: "reject" } }, handler: () => undefined,
    });
    const parent = defineWorkflow({ name: "parent-explicit-child", output: z.string(),
      handler: async (_input, context) => {
        const result = await context.runChild(child, "customer", { executionId: "named-child" });
        return result === undefined ? "child finished" : "unexpected result";
      },
    });
    const adapter = new MemoryWorkflowAdapter();
    const scheduler = new WorkflowScheduler([parent, child], adapter, new EmbeddedWorkflowActivityTransport(() => undefined));
    const handle = await new WorkflowClient(adapter).start(parent, null);

    await scheduler.runOnce();
    expect(await adapter.getHistory(handle.executionId)).toContainEqual(expect.objectContaining({
      type: "command-scheduled", kind: "child", payload: expect.objectContaining({
        executionId: "named-child", concurrency: { keyed: { key: "CUSTOMER", scope: "execution", conflict: "reject", limit: 1 } },
      }),
    }));
    await expect(adapter.get("named-child")).resolves.toMatchObject({
      workflowName: child.name, parentExecutionId: handle.executionId, input: "CUSTOMER",
      concurrency: { keyed: { key: "CUSTOMER", scope: "execution", conflict: "enqueue", limit: 1 } },
    });
    await scheduler.runOnce();
    await scheduler.runOnce();
    await expect(handle.status()).resolves.toMatchObject({ status: "completed" });
    await expect(handle.result()).resolves.toBe("child finished");
  });

  it.each([{ maxAttempts: 0 }, { backoffCoefficient: 0.5 }])(
    "rejects invalid activity retry tuning before staging a command (%j)",
    async (retry) => {
      const action = defineAction({ name: "activity.invalid-retry", output: z.null(), handler: () => null });
      const result = await new WorkflowReplayer().replay(baseSnapshot, (_input, workflow) =>
        new DurableWorkflowExecutionContext(workflow, {
          codec: jsonWorkflowPayloadCodec, cancellationRequested: false, createUuid: () => "unused", now: () => 0, signals: [],
        }).run(action, null, { retry }));
      expect(result).toEqual({ status: "failed", error: expect.any(TypeError), commands: [] });
    },
  );

  it("fails an undeclared signal wait before staging a durable command", async () => {
    const signal = defineWorkflowSignal({ name: "undeclared", payload: z.string() });
    const result = await new WorkflowReplayer().replay(baseSnapshot, (_input, workflow) =>
      new DurableWorkflowExecutionContext(workflow, {
        codec: jsonWorkflowPayloadCodec, cancellationRequested: false, createUuid: () => "unused", now: () => 0, signals: [],
      }).waitForSignal(signal as never));
    expect(result).toEqual({ status: "failed", error: new TypeError(
      'Signal "undeclared" is not declared by workflow execution "execution-1".',
    ), commands: [] });
  });

  it("omits absent timeout and child options from durable commands", async () => {
    const child = defineWorkflow({ name: "defaults.child", handler: () => undefined });
    const signal = defineWorkflowSignal({ name: "defaults.signal", payload: z.null() });
    const command = vi.fn().mockResolvedValue(null);
    const context = new DurableWorkflowExecutionContext({
      executionId: "defaults", version: 1, generation: 1, canDeliverCancellation: false,
      command, capture: vi.fn(),
    }, {
      codec: jsonWorkflowPayloadCodec, cancellationRequested: false,
      createUuid: () => "unused", now: () => 0, signals: [signal],
    });
    await expect(context.waitForSignal(signal)).resolves.toBeNull();
    await expect(context.runChild(child, null)).resolves.toBeUndefined();
    expect(command.mock.calls).toStrictEqual([
      ["signal", signal.name, {}, undefined],
      ["child", child.name, { input: null, version: 1 }, undefined],
    ]);
  });

  it.each([
    new WorkflowActivityTimeoutError("execution-1", 0, "schedule-to-close"),
    new WorkflowActivityInfrastructureError("activity unavailable"),
    new WorkflowCancellationError("execution-1"),
    new WorkflowSignalTimeoutError("execution-1", "approval"),
  ])("restores %s with its durable class, fields and stack", async (error) => {
    const result = await new WorkflowReplayer().replay({ ...baseSnapshot, revision: 2, history: [
      scheduled(0, "failed-command"),
      { type: "command-completed", eventIndex: 1, sequence: 0, completionOrder: 0, occurredAt: new Date(1), error: serializeWorkflowError(error) },
    ] }, (_input, workflow) => workflow.command("activity", "failed-command", null));
    expect(result).toMatchObject({ status: "failed", error: expect.any(error.constructor), commands: [] });
    if (result.status !== "failed") throw new Error("Expected a recorded failure.");
    expect(serializeWorkflowError(result.error)).toEqual(serializeWorkflowError(error));
  });

  it.each([{ kind: "timer", payload: null }, { kind: "activity", payload: "changed input" }])(
    "blocks reuse of a durable command position after changing kind or payload (%j)",
    async ({ kind, payload }) => {
      const result = await new WorkflowReplayer().replay({ ...baseSnapshot, revision: 1, history: [scheduled(0, "unchanged-target")] },
        (_input, workflow) => workflow.command(kind, "unchanged-target", payload));
      expect(result).toMatchObject({ status: "blocked", error: { name: "WorkflowNondeterminismError", sequence: 0 }, commands: [] });
    },
  );

  it("stages durable commands and waits without retaining the handler", async () => {
    const replayer = new WorkflowReplayer();

    await expect(replayer.replay(baseSnapshot, async (input, workflow) => {
      await workflow.command("activity", "example.read", input);
      return "done";
    })).resolves.toEqual({
      status: "waiting",
      commands: [{
        sequence: 0,
        kind: "activity",
        target: "example.read",
        payload: { value: "input" },
      }],
    });
  });

  it("replays completed commands in durable completion order", async () => {
    const replayer = new WorkflowReplayer();
    const result = await replayer.replay({
      ...baseSnapshot,
      revision: 4,
      history: [
        scheduled(0, "first"),
        scheduled(1, "second", 1),
        completed(1, 0, "B", 2),
        completed(0, 1, "A", 3),
      ],
    }, async (_input, workflow) => {
      const first = workflow.command<string>("activity", "first", null);
      const second = workflow.command<string>("activity", "second", null);
      return Promise.race([first, second]);
    });

    expect(result).toEqual({ status: "completed", output: "B", commands: [] });
  });

  it("orders command slots by sequence when a history snapshot arrives out of order", async () => {
    const result = await new WorkflowReplayer().replay({
      ...baseSnapshot, revision: 4,
      history: [scheduled(1, "second", 1), completed(1, 0, "second", 2),
        completed(0, 1, "first", 3), scheduled(0, "first")],
    }, async (_input, replay) => {
      const first = replay.command("activity", "first", null);
      const second = replay.command("activity", "second", null);
      return Promise.all([first, second]);
    });
    expect(result).toEqual({ status: "completed", output: ["first", "second"], commands: [] });
  });

  it("does not ask the codec to decode an absent activity result on a legacy replay context", async () => {
    const action = defineAction({
      name: "optional.activity", input: z.null(), output: z.string().optional(), handler: () => undefined,
    });
    const decode = vi.fn(() => "not a real result");
    const command = vi.fn().mockResolvedValue(undefined);
    const context = new DurableWorkflowExecutionContext({
      executionId: "legacy", version: 1, generation: 1, canDeliverCancellation: false,
      command, capture: vi.fn(),
    }, {
      codec: { encode: jsonWorkflowPayloadCodec.encode.bind(jsonWorkflowPayloadCodec), decode },
      cancellationRequested: false, createUuid: () => "unused", now: () => 0, signals: [],
    });
    await expect(context.run(action, null, { retry: { backoffCoefficient: 1 } })).resolves.toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledExactlyOnceWith("activity", action.name, {
      input: null, options: { maxAttempts: 1, initialDelayMs: 1_000, backoffCoefficient: 1 },
    }, undefined);
  });

  it("delivers cancellation before encoding another continuation", async () => {
    const encode = vi.fn();
    const context = new DurableWorkflowExecutionContext({
      executionId: "cancelled-run", version: 1, generation: 1, canDeliverCancellation: true,
      command: vi.fn(), capture: vi.fn(),
    }, {
      codec: { encode, decode: jsonWorkflowPayloadCodec.decode },
      cancellationRequested: true, createUuid: () => "unused", now: () => 0, signals: [],
    });
    expect(context.cancellationWasDelivered).toBe(false);
    await expect(context.continueAsNew(null)).rejects.toBeInstanceOf(WorkflowCancellationError);
    expect(context.cancellationWasDelivered).toBe(true);
    expect(encode).not.toHaveBeenCalled();
  });

  it("returns a blocked diagnostic for incompatible command history", async () => {
    const replayer = new WorkflowReplayer();
    const result = await replayer.replay({
      ...baseSnapshot,
      revision: 1,
      history: [scheduled(0, "old")],
    }, (_input, workflow) =>
      workflow.command("activity", "new", null));

    expect(result).toMatchObject({
      status: "blocked",
      error: {
        name: "WorkflowNondeterminismError",
        message: 'Workflow execution "execution-1" is non-deterministic at command 0: expected activity:old, received activity:new.',
        sequence: 0,
        expectedTarget: "old",
        actualTarget: "new",
      },
    });
  });

  it("rethrows recorded activity failures through ordinary try/catch", async () => {
    const replayer = new WorkflowReplayer();
    const result = await replayer.replay({
      ...baseSnapshot,
      revision: 2,
      history: [
        scheduled(0, "fails"),
        {
          type: "command-completed",
          eventIndex: 1,
          sequence: 0,
          completionOrder: 0,
          error: { name: "ExampleError", message: "failed" },
          occurredAt: new Date(1),
        },
      ],
    }, async (_input, workflow) => {
      try {
        await workflow.command("activity", "fails", null);
      } catch (error) {
        return (error as Error).name;
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      output: "ExampleError",
    });
  });
});

function scheduled(sequence: number, target: string, eventIndex = 0) {
  return {
    type: "command-scheduled" as const,
    eventIndex,
    sequence,
    kind: "activity",
    target,
    payload: null,
    occurredAt: new Date(eventIndex),
  };
}

function completed(
  sequence: number,
  completionOrder: number,
  result: string,
  eventIndex: number,
) {
  return {
    type: "command-completed" as const,
    eventIndex,
    sequence,
    completionOrder,
    result,
    occurredAt: new Date(eventIndex),
  };
}
