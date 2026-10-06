import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createCollectionQueryInputSchema,
  createPaginatedOutputSchema,
  defineAction,
} from "../actions/index.js";
import { defineHttpController, post } from "../http/index.js";
import { testHttpAccess } from "../testing/http_access.js";
import { defineWorker } from "../workers/index.js";
import {
  type AtlasHttpController,
  defineCatalogAtlasSource,
} from "./index.js";

const modelSchema = z.object({ id: z.string(), name: z.string() });
const list = defineAction({
  name: "model.list",
  input: createCollectionQueryInputSchema(),
  output: createPaginatedOutputSchema(modelSchema),
  handler: () => ({
    items: [],
    pageInfo: {
      type: "page" as const,
      page: 1,
      pageSize: 20,
      hasNextPage: false,
    },
  }),
});

describe("catalog atlas operation exposures", () => {
  it("preserves async policies through mapped boundaries and success effects", async () => {
    const operation = defineAction({
      name: "async.echo",
      input: z.string().refine(async () => true),
      output: z.string().refine(async () => true),
      validation: { input: "async", output: "async" },
      handler: (value) => value,
    });
    const source = defineCatalogAtlasSource({ id: "async-source", actions: { operation } });
    const reference = source.action(operation);
    const executor = { execute: async (_operation: unknown, value: unknown) => value };
    expect(reference.validation).toEqual({ input: "async", output: "async" });
    const mapped = reference
      .mapInput(z.object({ text: z.string() }), ({ text }) => text)
      .mapOutput(z.string().transform(async (value) => value.toUpperCase()), (value) => value, "async")
      .onSuccess(function* () {});
    expect(mapped.validation).toEqual({ input: "sync", output: "async" });
    await expect(mapped.execute({ text: "value" }, executor))
      .resolves.toEqual({ data: "VALUE", effects: [] });
    const syncOutput = reference.mapOutput(z.string(), (value) => value);
    expect(syncOutput.validation).toEqual({ input: "async", output: "sync" });
  });

  it("classifies HTTP controllers as reads or writes and workers as writes", async () => {
    const controller = defineHttpController({
      access: testHttpAccess,
      route: post("/models/preview"),
      input: z.object({ name: z.string() }),
      output: modelSchema,
      handler: ({ input }) => ({ id: "preview", name: input.name }),
    });
    const worker = defineWorker({
      name: "model.refresh",
      queue: "model-refresh",
      input: z.object({ id: z.string() }),
      handler: () => {},
    });
    const source = defineCatalogAtlasSource({
      id: "application",
      actions: { list },
      httpControllers: { controller },
      workers: { worker },
    });
    const query = source.query(controller);
    const action = source.action(controller);
    const workerAction = source.action(worker);

    // This compile-time assertion keeps workers out of read exposures.
    if (false) {
      // @ts-expect-error Workers can only be exposed as atlas Actions.
      source.query(worker);
    }

    expect(query.effect).toBe("read");
    expect(action.effect).toBe("write");
    expect(workerAction.effect).toBe("write");
    expect(workerAction.outputSchema.parse({ jobId: "job-1" }))
      .toEqual({ jobId: "job-1" });
  });

  it("requires exposed HTTP controllers to declare an output schema", () => {
    const controller = defineHttpController({
      access: testHttpAccess,
      route: post("/models/reindex"),
      handler: () => undefined,
    });
    const source = defineCatalogAtlasSource({
      id: "application",
      actions: { list },
      httpControllers: { controller },
    });

    expect(() => source.action(
      controller as unknown as AtlasHttpController,
    )).toThrow("declare an output schema");
  });

  it("maps the portable collection contract to the catalog contract", async () => {
    const source = defineCatalogAtlasSource({
      id: "application",
      actions: { list },
    });
    const reference = source.collectionQuery(list);
    const execute = vi.fn(async () => ({
      items: [],
      pageInfo: {
        type: "page" as const,
        page: 2,
        pageSize: 10,
        hasNextPage: false,
      },
    }));

    const result = await reference.execute({
      pagination: { type: "page", page: 2, pageSize: 10 },
      search: "Ada",
      filters: [{ field: "name", operator: "contains", value: "ad" }],
      sorting: [{ field: "name", direction: "desc" }],
    }, { execute });

    expect(execute).toHaveBeenCalledWith(list, {
      pagination: { type: "page", page: 2, pageSize: 10 },
      search: { term: "Ada" },
      filters: [{ field: "name", operator: "contains", value: "ad" }],
      sort: [{ field: "name", direction: "desc" }],
    });
    expect(result.effects).toEqual([]);
    expect(result.data.pageInfo).toMatchObject({ type: "page", page: 2 });
  });

  it("composes output derivations without changing the catalog Action", async () => {
    const source = defineCatalogAtlasSource({
      id: "application",
      actions: { list },
    });
    const derived = source.collectionQuery(list).mapOutput(
      z.object({ count: z.number() }),
      (output) => ({ count: output.items.length }),
    );

    const result = await derived.execute({
      pagination: { type: "page", page: 1, pageSize: 20 },
    }, {
      execute: async () => ({
        items: [{ id: "1", name: "Ada" }],
        pageInfo: {
          type: "page",
          page: 1,
          pageSize: 20,
          hasNextPage: false,
        },
      }),
    });

    expect(result.data).toEqual({ count: 1 });
    expect(derived.operation).toBe(list);
  });
});
