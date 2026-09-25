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

    await server.close();
    await app.dispose();
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
  action: "pause" | "resume" | "terminate",
) {
  return server.inject({
    method: "POST",
    url: "/_studio/api/extensions/workflows/control",
    payload: { executionId, action },
  });
}
