import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { MemoryWorkflowAdapter } from "./adapters/memory/index.js";
import { EmbeddedWorkflowActivityTransport } from "./activity_transport.js";
import { WorkflowClient } from "./client.js";
import { resolveWorkflowConcurrency } from "./concurrency.js";
import { WorkflowConcurrencyConflictError } from "./errors.js";
import { WorkflowScheduler } from "./scheduler.js";
import { defineWorkflowSignal } from "./signal.js";
import { defineWorkflow } from "./workflow.js";

describe("workflow concurrency", () => {
  it("admits execution-scoped keyed workflows in durable start order", async () => {
    const workflow = keyedWorkflow({ scope: "execution" });
    const runtime = createRuntime(workflow);
    const first = await runtime.client.start(workflow, { key: "order" });
    const second = await runtime.client.start(workflow, { key: "order" });
    const third = await runtime.client.start(workflow, { key: "order" });

    await expect(first.status()).resolves.toMatchObject({ status: "queued" });
    await expect(second.status()).resolves.toMatchObject({ status: "pending" });
    await expect(third.status()).resolves.toMatchObject({ status: "pending" });

    await runtime.scheduler.runOnce();

    await expect(first.status()).resolves.toMatchObject({ status: "completed" });
    await expect(second.status()).resolves.toMatchObject({ status: "queued" });
    await expect(third.status()).resolves.toMatchObject({ status: "pending" });
  });

  it("keeps unrelated keyed workflows independently runnable", async () => {
    const workflow = keyedWorkflow({ scope: "execution" });
    const runtime = createRuntime(workflow);
    await runtime.client.start(workflow, { key: "first" });
    await runtime.client.start(workflow, { key: "second" });

    await expect(runtime.scheduler.runOnce()).resolves.toMatchObject({
      reserved: 2,
    });
  });

  it("supports reject and return-existing conflict policies", async () => {
    const rejectedWorkflow = keyedWorkflow({ conflict: "reject" });
    const rejectedRuntime = createRuntime(rejectedWorkflow);
    await rejectedRuntime.client.start(rejectedWorkflow, { key: "order" });
    await expect(rejectedRuntime.client.start(
      rejectedWorkflow,
      { key: "order" },
    )).rejects.toBeInstanceOf(WorkflowConcurrencyConflictError);

    const attachedWorkflow = keyedWorkflow({ conflict: "return-existing" });
    const attachedRuntime = createRuntime(attachedWorkflow);
    const first = await attachedRuntime.client.start(
      attachedWorkflow,
      { key: "order" },
    );
    const attached = await attachedRuntime.client.start(
      attachedWorkflow,
      { key: "order" },
    );
    expect(attached.executionId).toBe(first.executionId);
  });

  it("releases active-work keyed capacity while executions wait", async () => {
    const resume = defineWorkflowSignal({
      name: "concurrency.resume",
      payload: z.null(),
    });
    const workflow = defineWorkflow({
      name: "concurrency.active-work",
      input: z.object({ key: z.string() }),
      signals: [resume],
      concurrency: {
        keyed: {
          key: ({ key }) => key,
          limit: 1,
          scope: "active-work",
        },
      },
      handler: async (_input, context) => {
        await context.waitForSignal(resume);
      },
    });
    const runtime = createRuntime(workflow, 1);
    const first = await runtime.client.start(workflow, { key: "order" });
    const second = await runtime.client.start(workflow, { key: "order" });

    await runtime.scheduler.runOnce();
    await runtime.scheduler.runOnce();

    await expect(first.status()).resolves.toMatchObject({ status: "waiting" });
    await expect(second.status()).resolves.toMatchObject({ status: "waiting" });
  });

  it("limits reserved work globally for one definition", async () => {
    const workflow = defineWorkflow({
      name: "concurrency.definition",
      input: z.object({ id: z.string() }),
      concurrency: { executions: { limit: 1 } },
      handler: () => undefined,
    });
    const runtime = createRuntime(workflow);
    await runtime.client.start(workflow, { id: "first" });
    await runtime.client.start(workflow, { id: "second" });

    await expect(runtime.scheduler.runOnce()).resolves.toMatchObject({
      reserved: 1,
    });
  });

  it("validates definition limits and derived keys", async () => {
    expect(() => defineWorkflow({
      name: "concurrency.invalid-limit",
      concurrency: { executions: { limit: 0 } },
      handler: () => undefined,
    })).toThrow(/definition concurrency limit/u);
    const workflow = defineWorkflow({
      name: "concurrency.invalid-key",
      input: z.string(),
      concurrency: { keyed: { key: () => "" } },
      handler: () => undefined,
    });

    await expect(createRuntime(workflow).client.start(workflow, "input"))
      .rejects.toThrow("non-empty strings");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["number", 42],
  ])("rejects an invalid %s business key before persisting the workflow", async (_label, key) => {
    const workflow = defineWorkflow({
      name: "concurrency.required-key",
      input: z.string(),
      // A JS caller or unchecked application callback can return a value outside the declaration.
      concurrency: { keyed: { key: () => key as unknown as string } },
      handler: () => undefined,
    });
    const { client, adapter } = createRuntime(workflow);
    await expect(client.start(workflow, "input", { executionId: "invalid-key" })).rejects.toThrow(/non-empty strings/u);
    expect(await adapter.get("invalid-key")).toBeUndefined();
  });

  it("resolves explicit and default keyed policy alongside the definition limit", () => {
    const key = (value: string) => `order:${value}`;
    expect(resolveWorkflowConcurrency(undefined, "a")).toBeUndefined();
    expect(resolveWorkflowConcurrency({ executions: { limit: 2 } }, "a")).toStrictEqual({ definitionLimit: 2 });
    expect(resolveWorkflowConcurrency({ keyed: { key } }, "a")).toStrictEqual({
      keyed: { key: "order:a", limit: 1, conflict: "enqueue", scope: "execution" },
    });
    expect(resolveWorkflowConcurrency({ executions: { limit: 2 }, keyed: { key, limit: 4, conflict: "reject", scope: "active-work" } }, "a")).toStrictEqual({
      definitionLimit: 2, keyed: { key: "order:a", limit: 4, conflict: "reject", scope: "active-work" },
    });
  });

  it.each([0, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid keyed concurrency limit %s at definition time", (limit) => {
    expect(() => defineWorkflow({
      name: "concurrency.invalid-keyed-limit", concurrency: { keyed: { key: () => "key", limit } }, handler: () => undefined,
    })).toThrow(/keyed concurrency limit/u);
  });
});

function keyedWorkflow(options: {
  conflict?: "enqueue" | "reject" | "return-existing";
  scope?: "active-work" | "execution";
}) {
  return defineWorkflow({
    name: `concurrency.keyed.${options.conflict ?? "enqueue"}.${options.scope ?? "execution"}`,
    input: z.object({ key: z.string() }),
    concurrency: {
      keyed: {
        key: ({ key }) => key,
        limit: 1,
        ...(options.conflict === undefined ? {} : { conflict: options.conflict }),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
      },
    },
    handler: () => undefined,
  });
}

function createRuntime(
  workflow: ReturnType<typeof keyedWorkflow> | ReturnType<typeof defineWorkflow>,
  batchSize = 10,
) {
  const adapter = new MemoryWorkflowAdapter();
  return {
    adapter,
    client: new WorkflowClient(adapter),
    scheduler: new WorkflowScheduler(
      [workflow],
      adapter,
      new EmbeddedWorkflowActivityTransport(() => undefined),
      { batchSize },
    ),
  };
}
