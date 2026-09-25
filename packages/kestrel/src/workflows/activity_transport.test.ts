import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import {
  ActionWorkflowActivityTransport,
  type WorkflowActivityExecution,
} from "./activity_transport.js";

describe("ActionWorkflowActivityTransport", () => {
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
