import {
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import { z } from "zod";

import { isTerminalWorkflowStatus, type WorkflowExecutionStatus } from "./adapter.js";
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
    expect(workflow).not.toHaveProperty("outputSchema");
    expect(workflow).not.toHaveProperty("description");
    expect(workflow).not.toHaveProperty("examples");
    expect(workflow).not.toHaveProperty("concurrency");
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
    expect(workflow.outputSchema?.parse("4")).toBe(4);
    expectTypeOf<WorkflowResult<typeof workflow>>().toEqualTypeOf<number>();
  });

  it("rejects invalid stable names and version ranges", () => {
    expect(() => defineWorkflow({
      name: "Invalid Name",
      handler: () => undefined,
    })).toThrow("Workflow workflow names must contain lowercase segments");

    expect(() => defineWorkflowSignal({
      name: "",
      payload: z.string(),
    })).toThrow("Workflow signal names cannot be empty.");

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

  it("keeps signal names, description, validation mode and payload schema in the public contract", () => {
    const payload = z.string().transform(Number);
    const options = { name: "order.approved_2", payload, validation: { input: "async" as const } };
    const signal = defineWorkflowSignal({ ...options, description: "Approval decision" });
    expect(signal).toStrictEqual({
      kind: "workflow-signal", name: "order.approved_2", description: "Approval decision",
      validation: { input: "async", output: "sync" }, payloadSchema: payload,
    });
    expect(defineWorkflowSignal(options)).not.toHaveProperty("description");
    expect(() => defineWorkflowSignal({ ...options, name: "Approval invalid" })).toThrow(/lowercase segments/u);
    expect(() => defineWorkflowSignal({ ...options, name: "valid!" })).toThrow(/lowercase segments/u);
  });

  it("defaults the oldest supported version to the declared current version", () => {
    const workflow = defineWorkflow({ name: "version.latest", version: { current: 3 }, handler: () => undefined });
    expect(workflow.version).toEqual({ current: 3, supportedFrom: 3 });
    expect(() => defineWorkflow({ name: "version.invalid", version: { current: 3, supportedFrom: 0 }, handler: () => undefined })).toThrow(/oldest supported version/u);
  });

  it.each([0, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid current or supported versions independently: %s", (value) => {
    const options = { name: "version.invalid", handler: () => undefined };
    expect(() => defineWorkflow({ ...options, version: { current: value, supportedFrom: 1 } })).toThrow(/current version must be/u);
    expect(() => defineWorkflow({ ...options, version: { current: 3, supportedFrom: value } })).toThrow(/oldest supported version must be/u);
  });

  it("classifies every durable execution status for terminal waiters", () => {
    const terminals: readonly WorkflowExecutionStatus[] = ["cancelled", "completed", "failed", "terminated"];
    const active: readonly WorkflowExecutionStatus[] = ["blocked", "cancelling", "pending", "queued", "running", "waiting"];
    expect(terminals.map(isTerminalWorkflowStatus)).toEqual([true, true, true, true]);
    expect(active.map(isTerminalWorkflowStatus)).toEqual([false, false, false, false, false, false]);
  });
});
