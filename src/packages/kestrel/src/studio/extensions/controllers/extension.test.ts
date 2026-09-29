import Fastify from "fastify";
import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { App } from "../../../app/index.js";
import {
  defineHttpController,
  get,
  HttpControllerManager,
  path,
  post,
} from "../../../http/index.js";
import { testHttpAccess } from "../../../testing/http_access.js";
import { Studio } from "../../studio.js";
import type { StudioHttpControllerCatalog } from "./contract.js";
import { defineControllersStudioExtension } from "./extension.js";

describe("controllers Studio extension", () => {
  it("preserves the catalog tree and documents explicit examples", async () => {
    const server = Fastify();
    const extension = defineControllersStudioExtension(
      {
        app: {
          health: defineHttpController({
            access: testHttpAccess,
            route: get("/health"),
            description: "Report application health.",
            handler: () => ({ status: "ok" }),
          }),
        },
        user: {
          get: defineHttpController({
            access: testHttpAccess,
            route: get("/users/:userId"),
            input: z.object({
              id: z.uuid().describe("User identifier."),
            }),
            bindings: { id: path("userId") },
            examples: [{
              name: "Known user",
              input: { id: "00000000-0000-4000-8000-000000000001" },
            }],
            handler: ({ input }) => input,
          }),
        },
      },
      { executionIdHeader: "x-test-execution-id" },
    );
    const studio = new Studio({ extensions: [extension] });
    const app = new App({});
    const manager = new HttpControllerManager(app, server);

    for (const controller of await studio.defineHttpControllers()) {
      manager.register(controller);
    }
    await app.start();

    const response = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/controllers",
    });
    const catalog = response.json<StudioHttpControllerCatalog>();

    expect(response.statusCode).toBe(200);
    expect(catalog.nodes.map((node) => node.id)).toEqual(["app", "user"]);
    expect(catalog.observability).toEqual({
      dataPath: "/_studio/api/extensions/development-observations",
      executionIdHeader: "x-test-execution-id",
    });
    expect(catalog.nodes[0]).toMatchObject({
      kind: "group",
      name: "app",
      children: [{
        kind: "controller",
        id: "app.health",
        method: "GET",
        url: "/health",
        access: "test.http.unrestricted",
        inputs: [],
        examples: [],
      }],
    });
    expect(catalog.nodes[1]).toMatchObject({
      kind: "group",
      children: [{
        id: "user.get",
        inputs: [{
          name: "id",
          sourceName: "userId",
          binding: "path",
          required: true,
          schema: {
            type: "string",
            format: "uuid",
            description: "User identifier.",
          },
        }],
        examples: [{
          name: "Known user",
          input: { id: "00000000-0000-4000-8000-000000000001" },
        }],
      }],
    });

    await server.close();
    await app.dispose();
  });

  it("generates a reusable request example from the input schema", async () => {
    const server = Fastify();
    const extension = defineControllersStudioExtension({
      user: {
        create: defineHttpController({
          access: testHttpAccess,
          route: post("/users"),
          input: z.object({
            email: z.email(),
            enabled: z.boolean().default(true),
          }),
          handler: ({ input }) => input,
        }),
      },
    });
    const studio = new Studio({ extensions: [extension] });
    const app = new App({});
    const manager = new HttpControllerManager(app, server);

    for (const controller of await studio.defineHttpControllers()) {
      manager.register(controller);
    }
    await app.start();

    const response = await server.inject({
      method: "GET",
      url: "/_studio/api/extensions/controllers",
    });

    expect(response.json()).toMatchObject({
      nodes: [{
        children: [{
          id: "user.create",
          inputs: [
            { name: "email", binding: "body", required: true },
            { name: "enabled", binding: "body", required: false },
          ],
          examples: [{
            name: "Generated example",
            input: {
              email: "user@example.com",
              enabled: true,
            },
          }],
        }],
      }],
    });

    await server.close();
    await app.dispose();
  });
});
