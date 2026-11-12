import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { App } from "../../../app/index.js";
import { DefinitionCatalogRegistry } from "../../../definitions/index.js";
import { HttpControllerManager } from "../../../http/index.js";
import {
  defineWorkflow,
  defineWorkflowSignal,
  type AnyWorkflow,
  MemoryWorkflowAdapter,
  WorkflowOperations,
} from "../../../workflows/index.js";
import { Studio } from "../../index.js";
import type {
  StudioWorkflowCatalog,
  StudioWorkflowExecutionDetails,
  StudioWorkflowExecutionPage,
} from "./contract.js";
import { defineWorkflowsStudioExtension } from "./extension.js";

const approval = defineWorkflowSignal({
  name: "approved",
  payload: z.object({ reviewer: z.string() }),
});
const workflow = defineWorkflow({
  name: "orders.fulfill",
  description: "Fulfill an order.",
  version: { current: 2, supportedFrom: 1 },
  input: z.object({ orderId: z.string() }),
  signals: [approval],
  handler: () => undefined,
});

describe("workflows Studio extension", () => {
  it("reuses encoded execution cursors and rejects malformed tokens at the HTTP boundary", async () => {
    const adapter = new MemoryWorkflowAdapter({ now: () => new Date("2026-09-18T12:00:00.000Z") });
    for (const executionId of ["a", "b", "c"]) {
      await adapter.start({ executionId, workflowName: workflow.name, workflowVersion: 2, input: { orderId: executionId } });
    }
    const { server, app } = await createTestApp(adapter);
    const list = vi.spyOn(adapter, "listExecutions");
    try {
      const url = "/_studio/api/extensions/workflows/executions";
      const firstResponse = await server.inject({ method: "GET", url: `${url}?limit=2` });
      expect(firstResponse.statusCode).toBe(200);
      const first = firstResponse.json<StudioWorkflowExecutionPage>();
      expect(first.items.map(({ executionId }) => executionId)).toEqual(["c", "b"]);
      const nextResponse = await server.inject({ method: "GET", url: `${url}?${new URLSearchParams({ limit: "2", cursor: first.nextCursor! })}` });
      expect(nextResponse.statusCode).toBe(200);
      expect(nextResponse.json<StudioWorkflowExecutionPage>().items.map(({ executionId }) => executionId)).toEqual(["a"]);
      list.mockClear();
      const invalid = await server.inject({ method: "GET", url: `${url}?cursor=b` });
      expect(invalid.statusCode).toBe(400);
      expect(list).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
      await server.close();
      await app.dispose();
    }
  });

  it("exposes definition provenance, paginated search and execution details", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start({
      executionId: "order-1",
      workflowName: workflow.name,
      workflowVersion: 2,
      input: { orderId: "A" },
    });
    const { server, app } = await createTestApp(adapter);

    const catalogResponse = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/workflows/catalog",
    });
    const executionsResponse = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/workflows/executions?status=queued&limit=1",
    });
    const detailsResponse = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/workflows/executions/order-1",
    });

    expect(catalogResponse.json<StudioWorkflowCatalog>()).toMatchObject({
      definitions: [{
        name: workflow.name,
        path: ["orders", "fulfill"],
        source: { kind: "application" },
        currentVersion: 2,
        supportedFrom: 1,
        signals: ["approved"],
      }],
    });
    expect(executionsResponse.json<StudioWorkflowExecutionPage>().items)
      .toMatchObject([{ executionId: "order-1", status: "queued" }]);
    expect(detailsResponse.json<StudioWorkflowExecutionDetails>()).toMatchObject({
      execution: { executionId: "order-1" },
      declaredSignals: ["approved"],
      graph: { nodes: [{ kind: "execution", executionId: "order-1" }] },
      observationPath: "/correlations/workflow.executionId/order-1",
    });

    await server.close();
    await app.dispose();
  });

  it("exposes archived runs, active waits and child execution results after a continuation", async () => {
    const now = new Date("2026-09-18T12:00:00.000Z");
    const timestamp = now.toISOString();
    const adapter = new MemoryWorkflowAdapter({ now: () => now });
    const executionId = "parent";
    const input = { orderId: "A" };
    await adapter.start({ executionId, workflowName: workflow.name, workflowVersion: 1, input });

    // Rotate the history before scheduling work so both generations can be inspected.
    const [initial] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await expect(adapter.continueAsNew({
      taskId: initial!.id, reservationToken: initial!.reservationToken,
      executionId, expectedRevision: 0, workflowVersion: 2, input,
    })).resolves.toBe(true);

    const [current] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await expect(adapter.commitActivation({
      taskId: current!.id, reservationToken: current!.reservationToken, executionId,
      expectedRevision: 0,
      commands: [
        { sequence: 0, kind: "timer", target: "sleep", payload: { durationMs: 2_000 } },
        { sequence: 1, kind: "signal", target: "approved", payload: {} },
        {
          sequence: 2, kind: "child", target: "legacy.child",
          payload: {
            executionId: "child", version: 1, input,
            concurrency: { keyed: { key: "A", limit: 1, conflict: "enqueue", scope: "execution" } },
          },
        },
      ],
      outcome: { status: "waiting" },
    })).resolves.toBe(true);
    const [childTask] = await adapter.reserveTasks({ kinds: ["workflow"], limit: 1, leaseMs: 1_000 });
    await expect(adapter.commitActivation({
      taskId: childTask!.id, reservationToken: childTask!.reservationToken,
      executionId: "child", expectedRevision: 0, commands: [],
      outcome: { status: "completed", output: { sent: true } },
    })).resolves.toBe(true);

    const { server, app } = await createTestApp(adapter);
    try {
      expect((await control(server, executionId, "pause")).statusCode).toBe(200);
      const prefix = "/_studio/api/extensions/workflows/executions";
      const parent = await server.inject(`${prefix}/parent`);
      const child = await server.inject(`${prefix}/child`);
      const childDetails = child.json<StudioWorkflowExecutionDetails>();
      expect(parent.statusCode).toBe(200);
      expect(child.statusCode).toBe(200);
      expect(childDetails).toMatchObject({
        declaredSignals: [],
        execution: {
          executionId: "child", status: "completed", output: { sent: true },
          completedAt: timestamp, parentExecutionId: executionId,
          parentCommandSequence: 2, rootExecutionId: executionId, concurrencyKey: "A",
        },
      });
      expect(parent.json<StudioWorkflowExecutionDetails>()).toMatchObject({
        execution: { historyGeneration: 2, workflowVersion: 2, pausedAt: timestamp },
        archives: [{ historyGeneration: 1, workflowVersion: 1, eventCount: 0, continuedAt: timestamp }],
        waits: [
          { sequence: 0, kind: "timer", target: "sleep", scheduledAt: timestamp, deadline: "2026-09-18T12:00:02.000Z" },
          { sequence: 1, kind: "signal", target: "approved", scheduledAt: timestamp },
        ],
        children: [childDetails.execution],
        graph: {
          nodes: expect.arrayContaining([
            expect.objectContaining({ id: "command:2", sequence: 2, completedAt: timestamp }),
            expect.objectContaining({ id: "execution:child", completedAt: timestamp }),
          ]),
          edges: expect.arrayContaining([{ from: "command:2", to: "execution:child", kind: "child" }]),
        },
      });
    } finally {
      await server.close();
      await app.dispose();
    }
  });

  it("validates signals and exposes pause, resume, retry and terminate controls", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start({
      executionId: "active",
      workflowName: workflow.name,
      workflowVersion: 2,
      input: { orderId: "A" },
    });
    await adapter.start({
      executionId: "failed",
      workflowName: workflow.name,
      workflowVersion: 1,
      input: { orderId: "B" },
    });
    adapter.failExecution("failed", { name: "TestError", message: "failed" });
    const authorize = vi.fn();
    const { server, app } = await createTestApp(adapter, authorize);

    expect((await control(server, "active", "pause")).statusCode).toBe(200);
    await expect(adapter.get("active")).resolves.toMatchObject({ pausedAt: expect.any(Date) });
    expect((await control(server, "active", "resume")).statusCode).toBe(200);
    const invalidSignal = await server.inject({
      method: "POST",
      url: "/_studio/api/extensions/workflows/signals",
      payload: {
        executionId: "active",
        signalName: "approved",
        payload: { reviewer: 42 },
      },
    });
    const validSignal = await server.inject({
      method: "POST",
      url: "/_studio/api/extensions/workflows/signals",
      payload: {
        executionId: "active",
        signalName: "approved",
        payload: { reviewer: "Ada" },
      },
    });
    const sendKeyedSignal = () => server.inject({
      method: "POST",
      url: "/_studio/api/extensions/workflows/signals",
      payload: {
        executionId: "active", signalName: "approved",
        payload: { reviewer: "Grace" }, idempotencyKey: "approval-2",
      },
    });
    const firstReceipt = (await sendKeyedSignal()).json();
    const repeatedReceipt = (await sendKeyedSignal()).json();
    const retry = await server.inject({
      method: "POST",
      url: "/_studio/api/extensions/workflows/control",
      payload: {
        executionId: "failed",
        action: "retry",
        newExecutionId: "failed-retry",
      },
    });
    const terminate = await control(server, "active", "terminate");

    expect(invalidSignal.statusCode).toBe(400);
    expect(validSignal.statusCode).toBe(200);
    expect(firstReceipt).toEqual({ id: expect.any(String), accepted: true });
    expect(repeatedReceipt).toEqual({ id: firstReceipt.id, accepted: false });
    expect(retry.json()).toMatchObject({
      execution: {
        executionId: "failed-retry",
        retryOfExecutionId: "failed",
        workflowVersion: 2,
      },
    });
    expect(terminate.statusCode).toBe(200);
    await expect(adapter.get("active")).resolves.toMatchObject({ status: "terminated" });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ operation: "signal" }));
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ operation: "terminate" }));
    const failed = await server.inject("/_studio/api/extensions/workflows/executions/failed");
    expect(failed.json<StudioWorkflowExecutionDetails>()).toMatchObject({
      execution: { error: { name: "TestError", message: "failed" } },
      retries: [{ executionId: "failed-retry" }],
    });

    await server.close();
    await app.dispose();
  });

  it("forwards all execution filters and blocks operator mutations when authorization denies them", async () => {
    const adapter = new MemoryWorkflowAdapter();
    const list = vi.spyOn(adapter, "listExecutions");
    const cancel = vi.spyOn(adapter, "requestCancellation");
    const authorize = vi.fn(({ operation }: { operation: string }) => {
      if (operation === "cancel") throw Object.assign(new Error("Operator denied."), {
        toHttpError: () => ({ statusCode: 403, message: "Operator denied." }),
      });
    });
    const { server, app } = await createTestApp(adapter, authorize);

    try {
      const query = new URLSearchParams({
        search: "order", workflowName: workflow.name, workflowVersion: "2",
        createdAfter: "2026-01-01", createdBefore: "2026-02-01",
        parentExecutionId: "parent", rootExecutionId: "root", paused: "false", limit: "3",
      });
      const result = await server.inject({
        url: `/_studio/api/extensions/workflows/executions?${query}`,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ items: [] });
      expect(list).toHaveBeenCalledExactlyOnceWith({
        search: "order", workflowNames: [workflow.name], workflowVersions: [2],
        createdAfter: new Date("2026-01-01"), createdBefore: new Date("2026-02-01"),
        parentExecutionId: "parent", rootExecutionId: "root", paused: false, limit: 3,
      });
      expect((await control(server, "protected", "cancel")).statusCode).toBe(403);
      expect(cancel).not.toHaveBeenCalled();
      expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
        operation: "cancel", executionId: "protected",
      }));
    } finally {
      await server.close();
      await app.dispose();
    }
  });

  it.each([
    { method: "GET", path: "/executions/deleted" },
    { method: "POST", path: "/signals", payload: { executionId: "deleted", signalName: "approved", payload: { reviewer: "Ada" } } },
    { method: "POST", path: "/control", payload: { executionId: "deleted", action: "retry" } },
  ] as const)("reports an absent execution as not found ($path)", async ({ method, path, ...options }) => {
    const { server, app } = await createTestApp(new MemoryWorkflowAdapter());
    try {
      const response = await server.inject({ method, url: `/_studio/api/extensions/workflows${path}`, ...options });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ message: 'Unknown workflow execution "deleted".' });
    } finally {
      await server.close();
      await app.dispose();
    }
  });

  it("returns conflict for a control that cannot change the execution state", async () => {
    const adapter = new MemoryWorkflowAdapter();
    await adapter.start({ executionId: "running", workflowName: workflow.name, workflowVersion: 2, input: { orderId: "A" } });
    await adapter.start({ executionId: "failed", workflowName: workflow.name, workflowVersion: 2, input: { orderId: "B" } });
    adapter.failExecution("failed", { name: "Error", message: "Failed" });
    const { server, app } = await createTestApp(adapter);
    try {
      const recover = await control(server, "running", "recover");
      const retry = await control(server, "running", "retry");
      expect(recover.statusCode).toBe(409);
      expect(recover.json()).toMatchObject({ message: expect.stringContaining("not valid") });
      expect(retry.statusCode).toBe(409);
      const collision = await server.inject({
        method: "POST",
        url: "/_studio/api/extensions/workflows/control",
        payload: { executionId: "failed", action: "retry", newExecutionId: "running" },
      });
      expect(collision.statusCode).toBe(409);
      expect(collision.json()).toMatchObject({ message: expect.stringContaining('"running" already exists') });
      expect((await control(server, "running", "cancel")).statusCode).toBe(200);
      await expect(adapter.get("running")).resolves.toMatchObject({ cancellationRequested: true });
    } finally {
      await server.close();
      await app.dispose();
    }
  });

  it("preserves real storage failures instead of reporting a missing execution", async () => {
    const adapter = new MemoryWorkflowAdapter();
    vi.spyOn(adapter, "get").mockRejectedValue(new Error("storage disconnected"));
    const { server, app } = await createTestApp(adapter);
    try {
      const response = await server.inject({ url: "/_studio/api/extensions/workflows/executions/stale" });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("storage disconnected");
    } finally {
      await server.close();
      await app.dispose();
    }
  });
});

async function createTestApp(
  adapter: MemoryWorkflowAdapter,
  authorize = vi.fn(),
) {
  const registry = new DefinitionCatalogRegistry<AnyWorkflow>({
    getIdentity: ({ name }) => name,
    identityName: "Workflow",
  }).register(workflow, { kind: "application" }, ["orders", "fulfill"]);
  const operations = new WorkflowOperations([workflow], adapter);
  const extension = defineWorkflowsStudioExtension(registry, operations, {
    authorize,
  });
  const studio = new Studio({ extensions: [extension] });
  const server = Fastify();
  const app = new App({});
  const manager = new HttpControllerManager(app, server);

  for (const controller of await studio.defineHttpControllers()) {
    manager.register(controller);
  }
  await app.start();
  return { server, app };
}

function control(
  server: ReturnType<typeof Fastify>,
  executionId: string,
  action: "pause" | "resume" | "terminate" | "cancel" | "recover" | "retry",
) {
  return server.inject({
    method: "POST",
    url: "/_studio/api/extensions/workflows/control",
    payload: { executionId, action },
  });
}
