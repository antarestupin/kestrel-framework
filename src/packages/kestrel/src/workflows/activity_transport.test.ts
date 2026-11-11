import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import {
  ActionWorkflowActivityTransport,
  EmbeddedWorkflowActivityTransport,
  executeWorkflowActivityWithTimeout,
  toWorkflowActivityExecution,
  type WorkflowActivityExecution,
} from "./activity_transport.js";

describe("ActionWorkflowActivityTransport", () => {
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
    expect(() => toWorkflowActivityExecution({ ...task, kind: "timer", payload: null })).toThrow(TypeError);
    expect(() => toWorkflowActivityExecution(task)).toThrow(TypeError);
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
