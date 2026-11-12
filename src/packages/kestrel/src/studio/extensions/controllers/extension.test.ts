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
        access: "Inherited from HTTP runtime",
        inputs: [],
        examples: [],
      }],
    });
    expect(catalog.nodes[1]).toMatchObject({
      kind: "group",
      children: [{
        id: "user.get",
        access: "test.http.unrestricted",
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

  it("documents implicit path fields and JSON examples with nested inputs and formats", async () => {
    const detail = defineHttpController({
      route: get("/entries/:entryId"),
      handler: ({ request }) => request.params,
    });
    const create = defineHttpController({
      route: post("/entries"),
      input: z.object({
        enabled: z.boolean(), count: z.number(), minimum: z.int().min(3),
        records: z.array(z.object({ value: z.literal("known"), optional: z.null() })),
        ref: z.union([z.enum(["draft", "active"]), z.int()]),
        date: z.iso.date(), timestamp: z.iso.datetime(),
        homepage: z.url(), hostname: z.hostname(), id: z.uuid(),
        example: z.string().meta({ examples: ["supplied"] }),
        pair: z.tuple([z.literal("report"), z.int().min(3)]),
        empty: z.array(z.string()).max(0),
        details: z.record(z.string(), z.number()),
      }),
      handler: ({ input }) => input,
    });
    const explicit = defineHttpController({
      route: get("/named"),
      input: z.object({ filter: z.string() }),
      examples: [{ input: { filter: "available" } }],
      handler: ({ input }) => input,
    });
    const studio = new Studio({ extensions: [defineControllersStudioExtension({ detail, create, explicit })] });
    const server = Fastify();
    const app = new App({});
    try {
      const manager = new HttpControllerManager(app, server);
      for (const controller of await studio.defineHttpControllers()) manager.register(controller);
      await app.start();
      const response = await server.inject({ url: "/_studio/api/extensions/controllers" });
      expect(response.statusCode).toBe(200);
      const catalog = response.json<StudioHttpControllerCatalog>();
      expect(catalog.observability).toBeUndefined();
      expect(catalog.nodes[0]).toMatchObject({
        id: "detail", inputs: [{ name: "entryId", sourceName: "entryId", binding: "path", required: true }],
        examples: [{ input: { entryId: "example" } }],
      });
      expect(catalog.nodes[1]).toMatchObject({
        id: "create", examples: [{ input: {
          enabled: true, count: 1, minimum: 3,
          records: [{ value: "known", optional: null }],
          ref: "draft", date: "2026-01-01", timestamp: "2026-01-01T12:00:00.000Z",
          homepage: "https://example.com", hostname: "example.com",
          id: "00000000-0000-4000-8000-000000000000", example: "supplied",
          pair: ["report", 3], empty: [], details: {},
        } }],
      });
      expect(catalog.nodes[2]).toMatchObject({
        id: "explicit", examples: [{ name: "Example 1", input: { filter: "available" } }],
      });
    } finally {
      await server.close();
      await app.dispose();
    }
  });
});
