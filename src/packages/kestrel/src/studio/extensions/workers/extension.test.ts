import Fastify from "fastify";
import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { App } from "../../../app/index.js";
import { HttpControllerManager } from "../../../http/index.js";
import { MemoryWorkerAdapter } from "../../../workers/adapters/memory/index.js";
import { defineWorker } from "../../../workers/worker.js";
import { Studio } from "../../index.js";
import type {
  StudioWorkerCatalog,
  StudioWorkerDetail,
} from "./contract.js";
import { defineWorkersStudioExtension } from "./extension.js";

describe("workers Studio extension", () => {
  it("preserves the catalog tree, queue state and explicit examples", async () => {
    const server = Fastify();
    const adapter = new MemoryWorkerAdapter({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const worker = defineWorker({
      name: "email.send",
      description: "Send one email.",
      queue: "emails",
      input: z.object({ email: z.email() }),
      examples: [{
        name: "Welcome email",
        payload: { email: "welcome@example.com" },
      }],
      handler: () => undefined,
    });
    await adapter.enqueue([
      { queue: worker.queue, payload: { email: "ready@example.com" } },
      {
        queue: worker.queue,
        payload: { email: "later@example.com" },
        availableAt: new Date("2026-01-01T01:00:00.000Z"),
      },
    ]);
    const extension = defineWorkersStudioExtension(
      { communication: { email: worker } },
      adapter,
      { observability: true },
    );
    const studio = new Studio({ extensions: [extension] });
    const app = new App({});
    const manager = new HttpControllerManager(app, server);

    for (const controller of await studio.defineHttpControllers()) {
      manager.register(controller);
    }
    await app.start();

    const catalogResponse = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/workers/catalog",
    });
    const catalog = catalogResponse.json<StudioWorkerCatalog>();
    const detailResponse = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/workers/catalog/communication.email",
    });
    const missingResponse = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/workers/catalog/unknown",
    });
    const pauseResponse = await server.inject({
      method: "POST",
      url: "/_studio/api/extensions/workers/queues/control",
      payload: { queue: "emails", enabled: false },
    });

    expect(catalogResponse.statusCode).toBe(200);
    expect(catalog.observability).toEqual({
      dataPath: "/_studio/api/extensions/development-observations",
    });
    expect(extension.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "worker",
        path: "/workers/$workerId",
        showInNavigation: false,
      }),
    ]));
    expect(catalog.nodes[0]).toMatchObject({
      kind: "group",
      children: [{
        kind: "worker",
        id: "communication.email",
        name: "email.send",
        description: "Send one email.",
        queue: "emails",
        enabled: true,
        ready: 1,
        scheduled: 1,
        reserved: 0,
        inputSchema: {
          type: "object",
          properties: { email: { type: "string", format: "email" } },
        },
        examples: [{
          name: "Welcome email",
          payload: { email: "welcome@example.com" },
        }],
      }],
    });
    expect(pauseResponse.statusCode).toBe(204);
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json<StudioWorkerDetail>()).toMatchObject({
      worker: {
        id: "communication.email",
        queue: "emails",
        ready: 1,
        scheduled: 1,
        reserved: 0,
      },
      observability: {
        dataPath: "/_studio/api/extensions/development-observations",
      },
    });
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json()).toMatchObject({
      message: "Worker \"unknown\" is not registered.",
    });
    await expect(adapter.listQueueStatistics(["emails"]))
      .resolves.toMatchObject([{ enabled: false }]);

    await server.close();
    await app.dispose();
  });

  it("validates payloads and enqueues a correlated first execution", async () => {
    const server = Fastify();
    const adapter = new MemoryWorkerAdapter({ createId: () => "job-1" });
    const worker = defineWorker({
      name: "email.send",
      queue: "emails",
      input: z.object({ email: z.email() }),
      handler: () => undefined,
    });
    const studio = new Studio({
      extensions: [defineWorkersStudioExtension({ email: worker }, adapter)],
    });
    const app = new App({});
    const manager = new HttpControllerManager(app, server);

    for (const controller of await studio.defineHttpControllers()) {
      manager.register(controller);
    }
    await app.start();

    const executionId = "00000000-0000-4000-8000-000000000001";
    const response = await server.inject({
      method: "POST",
      url: "/_studio/api/extensions/workers/enqueue",
      payload: {
        queue: "emails",
        payload: { email: "user@example.com" },
        executionId,
      },
    });
    const invalidResponse = await server.inject({
      method: "POST",
      url: "/_studio/api/extensions/workers/enqueue",
      payload: { queue: "emails", payload: { email: "invalid" } },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ jobId: "job-1", executionId });
    expect(adapter.inspectJobs()).toMatchObject([{
      id: "job-1",
      queue: "emails",
      payload: { email: "user@example.com" },
      executionId,
      attempt: 0,
    }]);
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.json()).toMatchObject({
      message: "The worker payload is invalid.",
    });

    await server.close();
    await app.dispose();
  });

  it("generates an execution ID and rejects queues outside the catalog", async () => {
    const server = Fastify();
    const adapter = new MemoryWorkerAdapter({ createId: () => "job-1" });
    const worker = defineWorker({
      name: "email.send",
      queue: "emails",
      input: z.object({ email: z.email() }),
      handler: () => undefined,
    });
    const studio = new Studio({
      extensions: [defineWorkersStudioExtension({ email: worker }, adapter)],
    });
    const app = new App({});
    const manager = new HttpControllerManager(app, server);

    for (const controller of await studio.defineHttpControllers()) {
      manager.register(controller);
    }
    await app.start();

    const enqueueResponse = await server.inject({
      method: "POST",
      url: "/_studio/api/extensions/workers/enqueue",
      payload: { queue: "emails", payload: { email: "user@example.com" } },
    });
    const controlResponse = await server.inject({
      method: "POST",
      url: "/_studio/api/extensions/workers/queues/control",
      payload: { queue: "unknown", enabled: false },
    });
    const catalogResponse = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/workers/catalog",
    });
    const result = enqueueResponse.json<{ executionId: string }>();

    expect(enqueueResponse.statusCode).toBe(201);
    expect(z.uuid().safeParse(result.executionId).success).toBe(true);
    expect(adapter.inspectJobs()[0]?.executionId).toBe(result.executionId);
    expect(controlResponse.statusCode).toBe(400);
    expect(catalogResponse.json()).toMatchObject({
      nodes: [{
        kind: "worker",
        examples: [{
          name: "Generated example",
          payload: { email: "user@example.com" },
        }],
      }],
    });

    await server.close();
    await app.dispose();
  });
});
