import Fastify, {
  type FastifyInstance,
  type FastifyReply,
} from "fastify";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { App } from "../app/index.js";
import { AuthenticationRequiredError } from "../authentication/index.js";
import {
  defineActionHttpController,
  defineHttpMiddleware,
  post,
} from "../http/index.js";
import { testHttpAccess } from "../testing/http_access.js";
import {
  defineWorker,
  MemoryWorkerAdapter,
  WorkerClient,
} from "../workers/index.js";
import {
  ATLAS_ASSET_BASE_PATH,
  AtlasProvider,
  type Atlas,
  type AtlasClientAdapter,
  type AtlasClientConfig,
  type AtlasClientRender,
  defineCatalogAtlasSource,
  defineAtlas,
  defineAtlasRecordAction,
  defineAtlasResource,
  atlasNotification,
  atlasRedirect,
} from "./index.js";

class TestAtlasClientAdapter implements AtlasClientAdapter {
  public readonly setup = vi.fn(
    async (
      server: FastifyInstance,
      _atlas: Atlas,
      _clientConfig: AtlasClientConfig,
    ): Promise<AtlasClientRender> => {
      server.addHook("onRequest", async (request, reply) => {
        if (request.url.startsWith(ATLAS_ASSET_BASE_PATH)) {
          return reply
            .type("application/javascript")
            .send("export const atlasAsset = true;");
        }
      });

      return (reply: FastifyReply) => reply
        .type("text/html")
        .send("<main>Atlas test client</main>");
    },
  );
}

const controllerMiddlewareRun = vi.fn();
const workerHandler = vi.fn();

function createTestAtlas(): Atlas {
  const modelSchema = z.object({ id: z.string(), name: z.string() });
  const idSchema = modelSchema.pick({ id: true });
  const writeSchema = z.object({ name: z.string() });
  const list = defineAction({
    name: "model.list",
    input: z.object({}),
    output: z.object({ items: z.array(modelSchema) }),
    handler: () => ({ items: [] }),
  });
  const read = defineAction({
    name: "model.get",
    input: idSchema,
    output: modelSchema.nullable(),
    handler: () => null,
  });
  const readMany = defineAction({
    name: "model.getMany",
    input: z.object({ ids: z.array(z.string()) }),
    output: z.array(modelSchema),
    handler: () => [],
  });
  const create = defineAction({
    name: "model.create",
    input: writeSchema,
    output: modelSchema,
    handler: ({ name }) => ({ id: "1", name }),
  });
  const update = defineAction({
    name: "model.update",
    input: idSchema.extend(writeSchema.partial().shape),
    output: modelSchema.nullable(),
    handler: () => null,
  });
  const remove = defineAction({
    name: "model.delete",
    input: idSchema,
    output: modelSchema.nullable(),
    handler: () => null,
  });
  const hidden = defineAction({
    name: "model.hidden",
    input: z.object({}),
    output: z.string(),
    handler: () => "hidden",
  });
  const copy = defineAction({
    name: "model.copy",
    input: idSchema,
    output: modelSchema,
    handler: ({ id }) => ({ id: `${id}-copy`, name: "Copied model" }),
  });
  const normalize = defineAction({
    name: "model.normalize",
    input: idSchema,
    output: modelSchema,
    handler: ({ id }) => ({ id, name: "Base normalized model" }),
  });
  const controller = defineActionHttpController(
    normalize,
    post("/models/:id/normalize"),
    testHttpAccess,
    {
      middleware: [defineHttpMiddleware("atlas-controller-test", {
        handler: async (_context, next) => {
          controllerMiddlewareRun();
          return next();
        },
      })],
      handler: async ({ action, input }) => ({
        ...await action.run(input),
        name: "Normalized model",
      }),
    },
  );
  const worker = defineWorker({
    name: "model.refresh",
    queue: "model-refresh",
    input: idSchema,
    handler: workerHandler,
  });
  const catalog = {
    list,
    read,
    readMany,
    create,
    update,
    delete: remove,
    hidden,
    copy,
  };
  const source = defineCatalogAtlasSource({
    id: "application",
    actions: catalog,
    httpControllers: { controller },
    workers: { worker },
  });

  return defineAtlas({
    basePath: "/management",
    resources: [defineAtlasResource({
      id: "model",
      label: "Models",
      identity: "id",
      source,
      capabilities: {
        list: source.query(catalog.list),
        read: source.query(catalog.read),
        readMany: source.query(catalog.readMany),
        create: source.action(catalog.create),
        update: source.action(catalog.update),
        delete: source.action(catalog.delete),
      },
      fields: {
        name: { searchable: true },
        ownerId: {
          filterable: ["equals"],
          relation: {
            resource: "model",
            cardinality: "one",
            lookup: {
              query: source.collectionQuery(catalog.list),
              pageSize: 10,
              minimumSearchLength: 1,
            },
          },
        },
      },
      recordActions: {
        copy: defineAtlasRecordAction({
          label: "Copy",
          action: source.action(catalog.copy)
            .onSuccess(function* ({ output }) {
              yield atlasNotification({
                level: "success",
                message: "Model copied.",
              });
              yield atlasRedirect({
                resource: "model",
                recordId: output.id,
              });
            })
            .mapOutput(z.null(), () => null),
          recordInput: "id",
        }),
        normalize: defineAtlasRecordAction({
          label: "Normalize",
          action: source.action(controller),
          recordInput: "id",
        }),
        refresh: defineAtlasRecordAction({
          label: "Refresh asynchronously",
          action: source.action(worker),
          recordInput: "id",
        }),
      },
    })],
  });
}

describe("AtlasProvider", () => {
  it("does not expose HTTP extensions when explicitly disabled", () => {
    const app = new App({});

    app.register(new AtlasProvider({
      enabled: false,
      atlas: createTestAtlas(),
      client: new TestAtlasClientAdapter(),
    }));

    expect(app.httpExtensions.definitions).toHaveLength(0);
  });

  it("mounts the manifest, SPA shell and asset scope", async () => {
    const server = Fastify();
    const app = new App({});
    const client = new TestAtlasClientAdapter();

    controllerMiddlewareRun.mockClear();
    workerHandler.mockClear();
    app.container.registerValue(
      "workerClient",
      new WorkerClient(new MemoryWorkerAdapter()),
    );

    app.register(new AtlasProvider({
      atlas: createTestAtlas(),
      client,
    }));
    for (const extension of app.httpExtensions.definitions) {
      await extension.mount({ app, server });
    }
    await app.start();

    const pageResponse = await server.inject({
      method: "GET",
      url: "/management/model/1",
    });
    const manifestResponse = await server.inject({
      method: "GET",
      url: "/management/api/manifest",
    });
    const missingApiResponse = await server.inject({
      method: "GET",
      url: "/management/api/missing",
    });
    const assetResponse = await server.inject({
      method: "GET",
      url: `${ATLAS_ASSET_BASE_PATH}main.tsx`,
    });
    const operationResponse = await server.inject({
      method: "POST",
      url: "/management/api/operations/resource%3Amodel%3Alist",
      payload: {
        input: {
          pagination: { type: "page", page: 1, pageSize: 20 },
        },
      },
    });
    const hiddenOperationResponse = await server.inject({
      method: "POST",
      url: "/management/api/operations/model.hidden",
      payload: { input: {} },
    });
    const relationLookupResponse = await server.inject({
      method: "POST",
      url: "/management/api/operations/resource%3Amodel%3Afield%3AownerId%3Alookup",
      payload: {
        input: {
          pagination: { type: "page", page: 1, pageSize: 10 },
          search: "Ada",
        },
      },
    });
    const unboundedRelationLookupResponse = await server.inject({
      method: "POST",
      url: "/management/api/operations/resource%3Amodel%3Afield%3AownerId%3Alookup",
      payload: {
        input: {
          pagination: { type: "page", page: 2, pageSize: 11 },
        },
      },
    });
    const shortRelationLookupResponse = await server.inject({
      method: "POST",
      url: "/management/api/operations/resource%3Amodel%3Afield%3AownerId%3Alookup",
      payload: {
        input: {
          pagination: { type: "page", page: 1, pageSize: 10 },
        },
      },
    });
    const unsupportedCollectionResponse = await server.inject({
      method: "POST",
      url: "/management/api/operations/resource%3Amodel%3Alist",
      payload: {
        input: {
          pagination: { type: "page", page: 1, pageSize: 20 },
          filters: [{ field: "id", operator: "equals", value: "1" }],
        },
      },
    });
    const recordActionResponse = await server.inject({
      method: "POST",
      url: "/management/api/resources/model/record-actions/copy",
      payload: { input: { id: "1" } },
    });
    const controllerActionResponse = await server.inject({
      method: "POST",
      url: "/management/api/resources/model/record-actions/normalize",
      payload: { input: { id: "1" } },
    });
    const workerActionResponse = await server.inject({
      method: "POST",
      url: "/management/api/resources/model/record-actions/refresh",
      payload: { input: { id: "1" } },
    });

    expect(pageResponse.body).toContain("Atlas test client");
    expect(manifestResponse.json()).toMatchObject({
      basePath: "/management",
      resources: [{ id: "model" }],
    });
    expect(missingApiResponse.statusCode).toBe(404);
    expect(missingApiResponse.json()).toEqual({
      error: "Atlas API route not found.",
    });
    expect(assetResponse.body).toContain("atlasAsset");
    expect(operationResponse.statusCode).toBe(200);
    expect(operationResponse.json()).toEqual({
      data: { items: [] },
      effects: [],
    });
    expect(hiddenOperationResponse.statusCode).toBe(404);
    expect(relationLookupResponse.statusCode).toBe(200);
    expect(relationLookupResponse.json()).toEqual({
      data: { items: [] },
      effects: [],
    });
    expect(unboundedRelationLookupResponse.statusCode).toBe(400);
    expect(shortRelationLookupResponse.statusCode).toBe(400);
    expect(unsupportedCollectionResponse.statusCode).toBe(400);
    expect(recordActionResponse.json()).toEqual({
      data: null,
      effects: [
        {
          type: "notification",
          level: "success",
          message: "Model copied.",
        },
        {
          type: "redirect",
          target: { resource: "model", recordId: "1-copy" },
        },
      ],
    });
    expect(controllerActionResponse.json()).toEqual({
      data: { id: "1", name: "Normalized model" },
      effects: [],
    });
    expect(controllerMiddlewareRun).toHaveBeenCalledOnce();
    expect(workerActionResponse.json()).toEqual({
      data: { jobId: expect.any(String) },
      effects: [],
    });
    expect(workerHandler).not.toHaveBeenCalled();
    expect(client.setup).toHaveBeenCalledOnce();

    await server.close();
    await app.dispose();
  });

  it("applies access middleware to the complete Atlas boundary", async () => {
    const server = Fastify();
    const app = new App({});
    const required = vi.fn();
    const unsafe = vi.fn();
    const denyAccess = defineHttpMiddleware("atlas-access-test", {
      handler: () => {
        required();
        throw new AuthenticationRequiredError();
      },
    });
    const unsafeAccess = defineHttpMiddleware("atlas-unsafe-test", {
      handler: (_context, next) => {
        unsafe();
        return next();
      },
    });
    const client = new TestAtlasClientAdapter();

    app.register(new AtlasProvider({
      atlas: createTestAtlas(),
      client,
      authentication: {
        passwordSignInUrl: "/authentication/password/sign-in",
        signOutUrl: "/authentication/sign-out",
        requiredSession: denyAccess,
        isAuthenticationRequired: (error) =>
          error instanceof AuthenticationRequiredError,
      },
      access: {
        unsafe: [unsafeAccess],
      },
    }));
    for (const extension of app.httpExtensions.definitions) {
      await extension.mount({ app, server });
    }
    await app.start();

    for (const url of [
      "/management",
      "/management/",
      "/management/model/1",
    ]) {
      const response = await server.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(302);
      expect(response.headers.location, url).toBe(
        `/management/login?returnTo=${encodeURIComponent(url)}`,
      );
      expect(response.headers["cache-control"], url).toBe("no-store");
    }

    for (const url of [
      "/management/api/manifest",
      "/management/api/missing",
    ]) {
      const response = await server.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
    }

    const loginResponse = await server.inject({
      method: "GET",
      url: "/management/login",
    });
    expect(loginResponse.statusCode).toBe(200);
    expect(loginResponse.body).toContain("Atlas test client");
    expect(loginResponse.headers["cache-control"]).toBe("no-store");

    const writeResponse = await server.inject({
      method: "POST",
      url: "/management/api/operations/resource%3Amodel%3Alist",
      payload: { input: {} },
    });
    expect(writeResponse.statusCode).toBe(401);
    const unknownWriteResponse = await server.inject({
      method: "POST",
      url: "/management/unknown",
    });
    expect(unknownWriteResponse.statusCode).toBe(401);
    expect(required).toHaveBeenCalledTimes(7);
    expect(unsafe).toHaveBeenCalledTimes(2);
    expect(client.setup.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      authentication: {
        loginPath: "/management/login",
        passwordSignInUrl: "/authentication/password/sign-in",
        signOutUrl: "/authentication/sign-out",
      },
    }));

    await server.close();
    await app.dispose();
  });

  it("validates the generic password-login configuration", () => {
    const atlas = createTestAtlas();
    const requiredSession = defineHttpMiddleware(
      "atlas-validation-session",
      { handler: (_context, next) => next() },
    );

    expect(() => new AtlasProvider({
      atlas,
      authentication: {
        loginPath: "login",
        passwordSignInUrl: "/authentication/password/sign-in",
        signOutUrl: "/authentication/sign-out",
        requiredSession,
        isAuthenticationRequired: () => true,
      },
    })).toThrow("login path");
    expect(() => new AtlasProvider({
      atlas,
      authentication: {
        passwordSignInUrl: "authentication/password/sign-in",
        signOutUrl: "/authentication/sign-out",
        requiredSession,
        isAuthenticationRequired: () => true,
      },
    })).toThrow("sign-in URL");
    expect(() => new AtlasProvider({
      atlas,
      authentication: {
        passwordSignInUrl: "//attacker.example/sign-in",
        signOutUrl: "/authentication/sign-out",
        requiredSession,
        isAuthenticationRequired: () => true,
      },
    })).toThrow("sign-in URL");
    expect(() => new AtlasProvider({
      atlas,
      authentication: {
        passwordSignInUrl: "/authentication/password/sign-in",
        signOutUrl: "//attacker.example/sign-out",
        requiredSession,
        isAuthenticationRequired: () => true,
      },
    })).toThrow("sign-out URL");
  });
});
