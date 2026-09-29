import {
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import { z } from "zod";

import {
  defineWorkflow,
  defineWorkflowSignal,
  type WorkflowResult,
} from "./index.js";

describe("workflow definitions", () => {
  it("uses a null input and no result contract by default", () => {
    const workflow = defineWorkflow({
      name: "empty.run",
      handler: (input) => {
        expectTypeOf(input).toEqualTypeOf<null>();
      },
    });

    expect(workflow.inputSchema.parse(null)).toBeNull();
    expect(workflow.outputSchema).toBeUndefined();
    expect(workflow.version).toEqual({ current: 1, supportedFrom: 1 });
    expect(workflow.signals).toEqual([]);
    expectTypeOf<WorkflowResult<typeof workflow>>().toEqualTypeOf<void>();
  });

  it("retains transformed schemas, metadata, signals, and supported versions", () => {
    const approval = defineWorkflowSignal({
      name: "order.approval",
      description: "Provides the order approval decision.",
      payload: z.object({ approved: z.boolean() }),
    });
    const workflow = defineWorkflow({
      name: "order.fulfill",
      description: "Fulfills one order.",
      version: { current: 3, supportedFrom: 2 },
      input: z.object({ count: z.coerce.number().int() }),
      output: z.string().transform(Number),
      examples: [{ name: "Small order", input: { count: 2 } }],
      signals: [approval],
      handler: ({ count }, context) => {
        expectTypeOf(count).toEqualTypeOf<number>();
        expectTypeOf(context.version).toEqualTypeOf<number>();
        return String(count);
      },
    });

    expect(workflow).toMatchObject({
      kind: "workflow",
      name: "order.fulfill",
      description: "Fulfills one order.",
      version: { current: 3, supportedFrom: 2 },
      signals: [approval],
    });
    expect(workflow.examples).toEqual([
      { name: "Small order", input: { count: 2 } },
    ]);
    expectTypeOf<WorkflowResult<typeof workflow>>().toEqualTypeOf<number>();
  });

  it("rejects invalid stable names and version ranges", () => {
    expect(() => defineWorkflow({
      name: "Invalid Name",
      handler: () => undefined,
    })).toThrow("lowercase segments");

    expect(() => defineWorkflowSignal({
      name: "",
      payload: z.string(),
    })).toThrow("cannot be empty");

    expect(() => defineWorkflow({
      name: "invalid.version",
      version: { current: 0 },
      handler: () => undefined,
    })).toThrow("positive integer");

    expect(() => defineWorkflow({
      name: "invalid.range",
      version: { current: 2, supportedFrom: 3 },
      handler: () => undefined,
    })).toThrow("cannot exceed");
  });

  it("rejects duplicate signal names inside one workflow", () => {
    const first = defineWorkflowSignal({
      name: "review.completed",
      payload: z.string(),
    });
    const second = defineWorkflowSignal({
      name: "review.completed",
      payload: z.number(),
    });

    expect(() => defineWorkflow({
      name: "review.run",
      signals: [first, second],
      handler: () => undefined,
    })).toThrow("must be unique");
  });
});
