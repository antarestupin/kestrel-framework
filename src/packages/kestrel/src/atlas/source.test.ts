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
  atlasNotification,
  atlasRedirect,
  defineCatalogAtlasSource,
  mapAtlasOperationInput,
  mapAtlasOperationOutput,
} from "./index.js";
import { atlasClientEffectSchema } from "./effects.js";

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

describe("Atlas client effect contract", () => {
  const target = { resource: "item", recordId: "one" };
  it("keeps redirects and the four notification levels across serialization", () => {
    const redirect = { type: "redirect", target };
    expect(atlasClientEffectSchema.parse(atlasRedirect(target))).toEqual(redirect);
    for (const level of ["success", "info", "warning", "error"] as const) {
      const notification = { level, message: "Saved", link: { label: "Open item", target } };
      expect(atlasClientEffectSchema.parse(atlasNotification(notification))).toEqual({ type: "notification", ...notification });
    }
  });

  it("rejects empty and malformed effect payloads at the gateway boundary", () => {
    for (const effect of [
      { type: "redirect", target: { ...target, resource: "" } },
      { type: "redirect", target: { ...target, recordId: 1 } },
      { type: "notification", level: "success", message: "" },
      { type: "notification", level: "debug", message: "Invalid level" },
      { type: "notification", level: "info", message: "Saved", link: { label: "", target } },
      { type: "notification", level: "info", message: "Saved", link: { label: "Open", target: { ...target, resource: "" } } },
    ]) expect(atlasClientEffectSchema.safeParse(effect).success).toBe(false);
  });
});

describe("catalog atlas operation exposures", () => {
  it.each(["", "Invalid", "1source", "source-Invalid"])("rejects the malformed source identifier %j", (id) => {
    expect(() => defineCatalogAtlasSource({ id, actions: { list } })).toThrow('Atlas source id');
  });

  it("preserves the parsed output when success effects leave it unchanged", async () => {
    const operation = defineAction({
      name: "mapped.length", input: z.string(), output: z.string(), handler: (value) => value,
    });
    const source = defineCatalogAtlasSource({ id: "mapped", actions: { operation } });
    const notification = atlasNotification({ level: "success", message: "Saved" });
    const reference = source.action(operation)
      .mapOutput(z.string().transform((value) => value.length), (value) => value)
      .onSuccess(function* ({ output }) {
        expect(output).toBe(3);
        yield notification;
      });

    await expect(reference.execute("Ada", { execute: async () => "Ada" }))
      .resolves.toEqual({ data: 3, effects: [notification] });
  });

  it("closes a success generator when a yielded effect fails validation", async () => {
    const operation = defineAction({
      name: "mapped.cleanup", input: z.string(), output: z.string(), handler: (value) => value,
    });
    const source = defineCatalogAtlasSource({ id: "mapped", actions: { operation } });
    const close = vi.fn();
    const reference = source.action(operation).onSuccess(async function* () {
      try {
        yield { type: "unrecognized" } as never;
      } finally {
        close();
      }
    });

    await expect(reference.execute("Ada", { execute: async () => "Ada" })).rejects.toBeInstanceOf(z.ZodError);
    expect(close).toHaveBeenCalledOnce();
  });

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
    expect(reference.derive(mapAtlasOperationInput(z.string(), (value) => value)).validation)
      .toEqual({ input: "sync", output: "async" });
    expect(reference.derive(mapAtlasOperationOutput(z.string(), String)).validation)
      .toEqual({ input: "async", output: "sync" });
    expect(reference.derive(mapAtlasOperationInput(z.string(), (value) => value, "async")).validation)
      .toEqual({ input: "async", output: "async" });
  });

  it("retains previously emitted effects when chaining success hooks", async () => {
    const source = defineCatalogAtlasSource({ id: "application", actions: { list } });
    const first = atlasNotification({ level: "info", message: "Started" });
    const second = atlasNotification({ level: "success", message: "Finished" });
    const reference = source.query(list).onSuccess(function* () { yield first; }).onSuccess(function* () { yield second; });
    const data = { items: [], pageInfo: { type: "page", page: 1, pageSize: 20, hasNextPage: false } };
    await expect(reference.execute({ pagination: { type: "page", page: 1, pageSize: 20 } }, { execute: async () => data }))
      .resolves.toEqual({ data, effects: [first, second] });
  });

  it("keeps async catalog output validation for a portable collection Query", async () => {
    const data = { items: [], pageInfo: { type: "page" as const, page: 1, pageSize: 20, hasNextPage: false } };
    const operation = defineAction({
      name: "async.list",
      input: list.inputSchema,
      output: list.outputSchema.refine(async () => true),
      validation: { input: "async", output: "async" },
      handler: () => data,
    });
    const source = defineCatalogAtlasSource({ id: "application", actions: { operation } });
    const reference = source.collectionQuery(operation);
    expect(reference.validation).toEqual({ input: "sync", output: "async" });
    await expect(reference.execute({ pagination: { type: "page", page: 1, pageSize: 20 } }, { execute: async () => data }))
      .resolves.toEqual({ data, effects: [] });
  });

  it("validates catalog-facing input and preserves effects through standalone derivations", async () => {
    const operation = defineAction({
      name: "derived.count",
      input: z.int().positive(),
      output: z.int(),
      handler: (count) => count,
    });
    const source = defineCatalogAtlasSource({ id: "count", actions: { operation } });
    const notification = atlasNotification({ level: "success", message: "Saved" });
    const reference = source.action(operation)
      .onSuccess(function* ({ output }) {
        yield notification;
        return output + 1;
      })
      .derive(mapAtlasOperationInput(z.object({ count: z.int() }), ({ count }) => count))
      .derive(mapAtlasOperationOutput(z.string(), (count) => String(count)));
    const execute = vi.fn(async (_operation: unknown, input: unknown) => input);

    // Reject mapped input before entering the catalog operation.
    await expect(reference.execute({ count: -1 }, { execute })).rejects.toBeInstanceOf(z.ZodError);
    expect(execute).not.toHaveBeenCalled();
    await expect(reference.execute({ count: 3 }, { execute }))
      .resolves.toEqual({ data: "4", effects: [notification] });
    expect(execute).toHaveBeenCalledExactlyOnceWith(operation, 3);
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
