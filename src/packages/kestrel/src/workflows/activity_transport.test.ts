import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { ExecutionContext } from "../app/execution_context.js";
import {
  ActionWorkflowActivityTransport,
  EmbeddedWorkflowActivityTransport,
  executeWorkflowActivityWithTimeout,
  getWorkflowActivityExecutionContext,
  setWorkflowActivityExecutionContext,
  toWorkflowActivityExecution,
  type WorkflowActivityExecution,
} from "./activity_transport.js";

describe("ActionWorkflowActivityTransport", () => {
  it.each([false, true])("uses the requested process ownership for an activity deadline (ref=%s)", async (ref) => {
    const result = Promise.withResolvers<null>();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const running = executeWorkflowActivityWithTimeout(
      { execute: () => result.promise }, { ...createActivity(), startToCloseTimeoutMs: 10_000 },
      new AbortController().signal, ref,
    );
    try {
      expect(timers.mock.results).toHaveLength(1);
      expect(timers.mock.results[0]?.value.hasRef()).toBe(ref);
    } finally {
      result.resolve(null);
      await running;
      timers.mockRestore();
    }
  });

  it("projects a legacy activity as generation one without exposing its payload", () => {
    const context = new ExecutionContext();
    const activity = createActivity();
    expect(getWorkflowActivityExecutionContext(context)).toBeUndefined();
    setWorkflowActivityExecutionContext(context, activity);
    expect(getWorkflowActivityExecutionContext(context)).toBe(activity);
    expect(context.get("workflow.generation")).toBe(1);
    expect(context.get("workflow.payload")).toBeUndefined();
  });

  it("gives the same command sequence a different effect identity after continue-as-new", () => {
    const task = {
      id: "activity-task",
      executionId: "an:execution",
      kind: "activity" as const,
      commandSequence: 0,
      target: "example.uppercase",
      payload: "input",
      attempt: 1,
      historyGeneration: 1,
    };
    const first = toWorkflowActivityExecution(task);
    const next = toWorkflowActivityExecution({ ...task, historyGeneration: 2 });
    const retry = toWorkflowActivityExecution({ ...task, historyGeneration: 2, attempt: 2 });
    const unrelated = toWorkflowActivityExecution({ ...task, executionId: "an:execution:2" });
    expect(first.idempotencyKey).toBe("an:execution:0");
    expect(next.historyGeneration).toBe(2);
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(next.idempotencyKey).not.toBe(unrelated.idempotencyKey);
    expect(retry.idempotencyKey).toBe(next.idempotencyKey);
  });

  it("keeps a legacy payload intact and falls back for malformed retry options", () => {
    const task = { id: "task", executionId: "legacy", kind: "activity" as const, commandSequence: 0, target: "legacy.action", attempt: 1 };
    const legacy = { input: "raw", options: "application data" };
    expect(toWorkflowActivityExecution({ ...task, payload: legacy })).toMatchObject({ payload: legacy, idempotencyKey: "legacy:0" });
    expect(toWorkflowActivityExecution({ ...task, payload: { input: null, options: {
      maxAttempts: 0, initialDelayMs: -1, backoffCoefficient: "invalid",
    } } })).toMatchObject({ payload: null, retry: { maxAttempts: 1, initialDelayMs: 1_000, backoffCoefficient: 2 } });
    for (const malformed of [
      { ...task, kind: "timer" as const, payload: null },
      { ...task, commandSequence: undefined, payload: null },
      { ...task, target: undefined, payload: null },
      task,
    ]) {
      expect(() => toWorkflowActivityExecution(malformed as typeof task)).toThrow(
        new TypeError('Workflow task "task" is not a valid activity.'),
      );
    }
  });

  it.each(["3", null, true])("falls back for nonnumeric retry values (%j)", (value) => {
    const activity = toWorkflowActivityExecution({
      id: "task", executionId: "execution", commandSequence: 0, kind: "activity", target: "example.activity",
      payload: { input: null, options: { maxAttempts: value, initialDelayMs: value } },
      attempt: 1,
    });
    expect(activity.retry).toEqual({ maxAttempts: 1, initialDelayMs: 1_000, backoffCoefficient: 2 });
  });

  it.each([null, [1, "input"], "input", false, { options: {} }, { input: 2, options: null }, { input: 2, options: [] }])(
    "preserves legacy activity input %j without manufacturing a deadline",
    (payload) => {
      const task = { id: "legacy-task", executionId: "legacy", kind: "activity" as const,
        commandSequence: 4, target: "legacy.action", attempt: 1 };
      expect(toWorkflowActivityExecution({ ...task, payload })).toStrictEqual({
        taskId: task.id, executionId: task.executionId, sequence: 4, historyGeneration: 1,
        target: task.target, payload, attempt: 1, idempotencyKey: "legacy:4",
        retry: { maxAttempts: 1, initialDelayMs: 1_000, backoffCoefficient: 2 },
      });
    },
  );

  it.each([
    { maxAttempts: 3, initialDelayMs: 0, expected: { maxAttempts: 3, initialDelayMs: 0 } },
    { maxAttempts: 1.5, initialDelayMs: 1.5, expected: { maxAttempts: 1, initialDelayMs: 1_000 } },
    { maxAttempts: "3", initialDelayMs: "2", expected: { maxAttempts: 1, initialDelayMs: 1_000 } },
  ])("validates the stored retry bounds and keeps both deadlines", ({ maxAttempts, initialDelayMs, expected }) => {
    const activity = toWorkflowActivityExecution({
      id: "scheduled", executionId: "run", historyGeneration: 2, kind: "activity",
      commandSequence: 1, target: "paid", attempt: 2,
      payload: { input: null, options: { maxAttempts, initialDelayMs, backoffCoefficient: 3,
        maxDelayMs: 300, scheduleToCloseTimeoutMs: 1_000, startToCloseTimeoutMs: 200 } },
    });
    expect(activity).toEqual({
      taskId: "scheduled", executionId: "run", historyGeneration: 2, sequence: 1,
      target: "paid", attempt: 2, idempotencyKey: "run:1:generation-2", payload: null,
      retry: { ...expected, backoffCoefficient: 3, maxDelayMs: 300 },
      scheduleToCloseTimeoutMs: 1_000, startToCloseTimeoutMs: 200,
    });
  });

  it.each([false, true])("cleans an owned activity timer after an early settlement (failure=%s)", async (fails) => {
    vi.useFakeTimers();
    const failure = new Error("Activity ended");
    const abort = vi.fn();
    const resolve = vi.fn();
    const reject = vi.fn();
    const execute = vi.fn<import("./activity_transport.js").WorkflowActivityTransport["execute"]>(
      (_activity, signal) => {
        signal.addEventListener("abort", abort, { once: true });
        return fails ? Promise.reject(failure) : Promise.resolve("ready");
      },
    );
    try {
      void executeWorkflowActivityWithTimeout(
        { execute }, { ...createActivity(), startToCloseTimeoutMs: 50 }, new AbortController().signal, false,
      ).then(resolve, reject);
      await vi.advanceTimersByTimeAsync(0);
      if (fails) {
        expect(reject).toHaveBeenCalledExactlyOnceWith(failure);
        expect(resolve).not.toHaveBeenCalled();
      } else {
        expect(resolve).toHaveBeenCalledExactlyOnceWith("ready");
        expect(reject).not.toHaveBeenCalled();
      }
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(abort).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("fails explicitly for missing targets in both transport modes", async () => {
    const activity = createActivity();
    const signal = new AbortController().signal;
    const execute = vi.fn();
    await expect(new ActionWorkflowActivityTransport([], { execute }).execute(activity, signal))
      .rejects.toThrow(`Unknown workflow Action "${activity.target}".`);
    await expect(new EmbeddedWorkflowActivityTransport(() => undefined).execute(activity, signal))
      .rejects.toThrow(`Unknown embedded workflow activity "${activity.target}".`);
    expect(execute).not.toHaveBeenCalled();
  });

  it("forwards deadlines and generation through the embedded activity contract", async () => {
    const handler = vi.fn(() => "done");
    const transport = new EmbeddedWorkflowActivityTransport(() => handler);
    const activity = { ...createActivity(), historyGeneration: 2, scheduleToCloseTimeoutMs: 60, startToCloseTimeoutMs: 30 };
    const signal = new AbortController().signal;
    await expect(transport.execute(activity, signal)).resolves.toBe("done");
    expect(handler).toHaveBeenCalledExactlyOnceWith(activity.payload, expect.objectContaining({
      historyGeneration: 2, scheduleToCloseTimeoutMs: 60, startToCloseTimeoutMs: 30,
    }), signal);
  });

  it("passes the caller's signal and omits absent metadata for an unbounded legacy activity", async () => {
    const activity = createActivity();
    const signal = new AbortController().signal;
    const handler = vi.fn(() => null);
    const transport = new EmbeddedWorkflowActivityTransport(() => handler);
    await expect(executeWorkflowActivityWithTimeout(transport, activity, signal, false)).resolves.toBeNull();
    const { payload, ...metadata } = activity;
    expect(handler.mock.calls).toStrictEqual([[payload, metadata, signal]]);
  });

  it("does not create optional deadlines from invalid stored option values", () => {
    const activity = toWorkflowActivityExecution({
      id: "task", executionId: "run", commandSequence: 0, kind: "activity", target: "work", attempt: 1,
      payload: { input: null, options: { maxDelayMs: "soon", scheduleToCloseTimeoutMs: "later", startToCloseTimeoutMs: null } },
    });
    expect(activity.retry).toStrictEqual({ maxAttempts: 1, initialDelayMs: 1_000, backoffCoefficient: 2 });
    expect(activity).not.toHaveProperty("scheduleToCloseTimeoutMs");
    expect(activity).not.toHaveProperty("startToCloseTimeoutMs");
  });

  it("validates Action input and output around the injected execution scope", async () => {
    const action = defineAction({
      name: "example.uppercase",
      input: z.object({ value: z.string().refine(async () => true) }),
      validation: { input: "async", output: "async" },
      output: z.object({ value: z.string().refine(async () => true) }),
      handler: ({ value }) => ({ value: value.toUpperCase() }),
    });
    const calls: Array<{ input: unknown; idempotencyKey: string }> = [];
    const transport = new ActionWorkflowActivityTransport([action], {
      execute: (definition, input, activity) => {
        calls.push({ input, idempotencyKey: activity.idempotencyKey });
        return definition.handler(input as never, {} as never);
      },
    });

    await expect(transport.execute(createActivity(), new AbortController().signal))
      .resolves.toEqual({ value: "VALUE" });
    expect(calls).toEqual([{
      input: { value: "value" },
      idempotencyKey: "execution:0",
    }]);
  });

  it("rejects a result that violates the Action output schema", async () => {
    const action = defineAction({
      name: "example.invalid-output",
      input: z.string(),
      output: z.number(),
      handler: () => 1,
    });
    const transport = new ActionWorkflowActivityTransport([action], {
      execute: () => "invalid",
    });

    await expect(transport.execute({
      ...createActivity(),
      target: action.name,
      payload: "input",
    }, new AbortController().signal)).rejects.toThrow();
  });

  it("does not invoke an Action after its signal aborts during async input preparation", async () => {
    const abort = new AbortController();
    const reason = new Error("activity reservation lost");
    const action = defineAction({ name: "lease.protected", input: z.string(), handler: () => null });
    const execute = vi.fn();
    const transport = new ActionWorkflowActivityTransport([action], {
      codec: { decode: async (value) => { abort.abort(reason); return value; }, encode: () => null },
      execute,
    });

    await expect(transport.execute({ ...createActivity(), target: action.name, payload: "input" }, abort.signal)).rejects.toBe(reason);
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves a start-to-close deadline beyond Node's maximum timer duration", async () => {
    vi.useFakeTimers();
    const maximum = 2_147_483_647;
    const rejection = vi.fn();
    const aborted = vi.fn();
    const pending = Promise.withResolvers<undefined>();
    try {
      void executeWorkflowActivityWithTimeout({
        execute: (_activity, signal) => {
          signal.addEventListener("abort", () => aborted(signal.reason), { once: true });
          return pending.promise;
        },
      }, { ...createActivity(), startToCloseTimeoutMs: maximum + 100 }, new AbortController().signal, false).catch(rejection);
      await vi.advanceTimersByTimeAsync(maximum + 99);
      expect(rejection).not.toHaveBeenCalled();
      expect(aborted).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(rejection).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ timeoutKind: "start-to-close" }));
      expect(aborted).toHaveBeenCalledExactlyOnceWith(rejection.mock.calls[0]![0]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { pending.resolve(undefined); vi.useRealTimers(); }
  });
});

function createActivity(): WorkflowActivityExecution {
  return {
    taskId: "task",
    executionId: "execution",
    sequence: 0,
    target: "example.uppercase",
    payload: { value: "value" },
    attempt: 1,
    idempotencyKey: "execution:0",
    retry: {
      maxAttempts: 1,
      initialDelayMs: 1_000,
      backoffCoefficient: 2,
    },
  };
}
