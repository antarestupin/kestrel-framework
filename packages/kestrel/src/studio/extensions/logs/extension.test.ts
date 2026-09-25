import Fastify, { type FastifyInstance } from "fastify";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { App } from "../../../app/index.js";
import { HttpControllerManager } from "../../../http/index.js";
import type { DevLogSource } from "../../../log/db/log_store.js";
import { Studio } from "../../studio.js";
import { defineDevLogsExtension } from "./extension.js";

describe("development logs Studio extension", () => {
  it("exposes paginated logs using the shared JSON contract", async () => {
    const source = createSource();
    const server = Fastify();
    const studio = new Studio({
      extensions: [defineDevLogsExtension(source)],
    });

    const app = await registerStudioControllers(studio, server);

    const response = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/development-logs/logs?before=20&level=40&limit=10&workload=workers",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          id: 19,
          loggedAt: "2026-08-04T10:00:00.000Z",
          level: 40,
          message: "Example warning",
          requestId: "req-1",
          workload: "workers",
          payload: { component: "test", workload: "workers" },
          createdAt: "2026-08-04T10:00:01.000Z",
        },
      ],
      nextBefore: 19,
    });
    expect(source.list).toHaveBeenCalledWith({
      before: 20,
      level: 40,
      limit: 10,
      workload: "workers",
    });

    await server.close();
    await app.dispose();
  });

  it("rejects invalid pagination before reading the database", async () => {
    const source = createSource();
    const server = Fastify();
    const studio = new Studio({
      extensions: [defineDevLogsExtension(source)],
    });

    const app = await registerStudioControllers(studio, server);

    const response = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/development-logs/logs?limit=0",
    });

    expect(response.statusCode).toBe(400);
    expect(source.list).not.toHaveBeenCalled();

    await server.close();
    await app.dispose();
  });

  it("clears captured logs", async () => {
    const source = createSource();
    const server = Fastify();
    const studio = new Studio({
      extensions: [defineDevLogsExtension(source)],
    });

    const app = await registerStudioControllers(studio, server);

    const response = await server.inject({
      method: "DELETE",
      url: "/_studio/api/extensions/development-logs/logs",
    });

    expect(response.statusCode).toBe(204);
    expect(source.clear).toHaveBeenCalledOnce();

    await server.close();
    await app.dispose();
  });
});

async function registerStudioControllers(
  studio: Studio,
  server: FastifyInstance,
): Promise<App<Record<string, never>>> {
  const app = new App({});
  const manager = new HttpControllerManager(app, server);

  for (const controller of await studio.defineHttpControllers()) {
    manager.register(controller);
  }
  await app.start();

  return app;
}

function createSource(): DevLogSource & {
  clear: ReturnType<typeof vi.fn<DevLogSource["clear"]>>;
  list: ReturnType<typeof vi.fn<DevLogSource["list"]>>;
} {
  return {
    clear: vi.fn<DevLogSource["clear"]>(async () => undefined),
    list: vi.fn<DevLogSource["list"]>(async () => ({
      items: [
        {
          id: 19,
          loggedAt: new Date("2026-08-04T10:00:00.000Z"),
          level: 40,
          message: "Example warning",
          requestId: "req-1",
          payload: { component: "test", workload: "workers" },
          createdAt: new Date("2026-08-04T10:00:01.000Z"),
        },
      ],
      nextBefore: 19,
    })),
    listByExecution: vi.fn<DevLogSource["listByExecution"]>(async () => []),
    listByExecutions: vi.fn<DevLogSource["listByExecutions"]>(async () => []),
  };
}
