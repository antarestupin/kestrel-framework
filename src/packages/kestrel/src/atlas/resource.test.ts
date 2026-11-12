import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { App } from "../app/index.js";
import { AuthenticationRequiredError } from "../authentication/index.js";
import { defineHttpMiddleware, HttpControllerManager } from "../http/index.js";
import { atlasCollectionQuerySchema, createResourceCollectionQuerySchema } from "./collection.js";
import { defineAtlas } from "./atlas.js";
import { defineAtlasResource, type AtlasResourceOptions } from "./resource.js";
import { defineCatalogAtlasSource } from "./source.js";

const row = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  amount: z.int(),
  due: z.iso.date(),
  timestamp: z.iso.datetime(),
  active: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  ownerId: z.string().nullable(),
});
const listOutput = z.object({ items: z.array(row) });
const list = defineAction({ name: "resource.list", input: z.object({}), output: listOutput, handler: () => ({ items: [] }) });
const read = defineAction({ name: "resource.read", input: z.object({ id: z.string() }), output: row.nullable(), handler: () => null });
const readMany = defineAction({ name: "resource.readMany", input: z.object({ ids: z.array(z.string()) }), output: z.array(row), handler: () => [] });
const edit = defineAction({
  name: "resource.edit", description: "Edit the selected resource.",
  input: z.object({ id: z.string(), note: z.string(), ownerId: z.string().optional() }),
  output: row.nullable(), handler: () => null,
});
const relatedInput = atlasCollectionQuerySchema.extend({ teamId: z.string() });
const relatedHandler = vi.fn((_input: z.output<typeof relatedInput>) => ({ items: [] }));
const related = defineAction({ name: "resource.related", input: relatedInput, output: listOutput, handler: relatedHandler });
const otherSource = defineCatalogAtlasSource({ id: "other", actions: { read } });
const source = defineCatalogAtlasSource({ id: "catalog", actions: { list, read, readMany, edit, related } });
const capabilities = { list: source.collectionQuery(list), read: source.query(read), readMany: source.query(readMany) };
const base: AtlasResourceOptions = { id: "item", label: "Items", source, identity: "id", capabilities };
const owner = { resource: "team", cardinality: "one" } as const;
const recordAction = { label: "Edit", action: source.action(edit), recordInput: "id" };

describe("Atlas resource declarations", () => {
  it.each([
    [{ label: " " }, "resource label cannot be empty"],
    [{ identity: " " }, "resource identity cannot be empty"],
    [{ identity: "missing" }, 'identity "missing" does not exist'],
    [{ identity: "constructor" }, 'identity "constructor" does not exist'],
    [{ displayField: "toString" }, 'display field "toString" does not exist'],
    [{ display: "name", displayField: "id" }, "Use either display or displayField"],
    [{ readManyBatchSize: 0 }, "readManyBatchSize must be a positive safe integer"],
    [{ fields: { __atlas_display: {} } }, "__atlas_display field is reserved"],
    [{ capabilities: { ...capabilities, read: otherSource.query(read) } }, 'operation from source "other"'],
    [{ capabilities: { ...capabilities, readMany: source.action(readMany) } }, "readMany capability must reference a Query"],
    [{ capabilities: { ...capabilities, readMany: source.query(read) } }, 'readMany capability must accept an "ids" input'],
    [{ views: { preview: { label: " ", query: source.query(read) } } }, "non-empty label"],
    [{ views: { preview: { label: "Preview", query: source.action(read) } } }, "must reference a Query"],
    [{ recordActions: { edit: { ...recordAction, label: " " } } }, "non-empty label"],
    [{ recordActions: { edit: { ...recordAction, action: source.query(edit) } } }, "must reference an Action"],
    [{ recordActions: { edit: { ...recordAction, recordInput: "absent" } } }, 'input "absent" does not exist'],
    [{ recordActions: { edit: { ...recordAction, inputs: { absent: {} } } } }, 'references unknown input "absent"'],
    [{ recordActions: { edit: { ...recordAction, inputs: { id: {} } } } }, 'cannot configure its bound record input "id"'],
    [{ recordActions: { edit: { ...recordAction, feedback: { error: " " } } } }, "feedback message"],
  ] satisfies readonly [Partial<AtlasResourceOptions>, string][])("rejects invalid resource metadata (%s)", (overrides, message) => {
    expect(() => defineAtlasResource({ ...base, ...overrides }).toManifest()).toThrow(message);
  });

  it.each([
    [{ kind: "relation" }, "must define its target relation"],
    [{ kind: "number", relation: owner }, 'cannot combine kind "number" with a relation'],
    [{ relation: { ...owner, resource: " " } }, "must reference a Resource"],
    [{ relation: { ...owner, lookup: { pageSize: 101 } } }, "lookup page size"],
    [{ relation: { ...owner, lookup: { minimumSearchLength: -1 } } }, "lookup minimum search length"],
    [{ relation: { ...owner, relatedRecords: { pageSize: 2.5 } } }, "related records page size"],
    [{ relation: { ...owner, relatedRecords: { label: " " } } }, "related records label cannot be empty"],
    [{ relation: { ...owner, inverseCardinality: "one", relatedRecords: {} } }, "inverse cardinality"],
    [{ relation: { ...owner, relatedRecords: { query: source.action(related) } } }, "related records operation must reference a Query"],
    [{ relation: { ...owner, relatedRecords: { query: source.query(related) } } }, "must define its record input"],
    [{ relation: { ...owner, relatedRecords: { query: source.query(related), recordInput: "pagination" } } }, "reserved"],
    [{ relation: { ...owner, relatedRecords: { query: source.query(related), recordInput: "unknown" } } }, 'input "unknown" does not exist'],
    [{ relation: { ...owner, relatedRecords: { query: source.query(read), recordInput: "id" } } }, 'must accept a "pagination" input'],
    [{ relation: { ...owner, relatedRecords: { recordInput: "teamId" } } }, "without a Query"],
  ] satisfies readonly [NonNullable<AtlasResourceOptions["fields"]>[string], string][])("validates relation declarations (%s)", (field, message) => {
    expect(() => defineAtlasResource({ ...base, fields: { ownerId: field } })).toThrow(message);
  });

  it("compiles legal scalar filters, inferred kinds and Action parameter presentation", () => {
    const resource = defineAtlasResource({
      ...base, readManyBatchSize: 4,
      capabilities: { ...capabilities, update: source.action(edit) },
      fields: {
        id: { filterable: true }, name: { filterable: ["contains", "contains"] },
        email: { filterable: ["starts-with"] }, amount: { filterable: ["greater-than"] },
        due: { filterable: ["less-than"] }, timestamp: { filterable: ["greater-than-or-equal"] },
        active: { filterable: ["equals"] }, metadata: { filterable: ["is-not-null"] },
        ownerId: { relation: { ...owner, relatedRecords: false }, filterable: ["is-null", "in"] },
      },
      recordActions: { edit: { ...recordAction, confirmation: "Confirm edit", feedback: { success: "Edited" }, inputs: { note: { label: "Change note" } } } },
    }).toManifest();
    expect(resource.readManyBatchSize).toBe(4);
    expect(resource.fields.map(({ id, kind, filterOperators }) => [id, kind, filterOperators])).toEqual([
      ["id", "id", ["equals"]], ["name", "text", ["contains"]], ["email", "email", ["starts-with"]],
      ["amount", "number", ["greater-than"]], ["due", "date", ["less-than"]],
      ["timestamp", "datetime", ["greater-than-or-equal"]], ["active", "boolean", ["equals"]],
      ["metadata", "json", ["is-not-null"]], ["ownerId", "relation", ["is-null", "in"]],
    ]);
    expect(resource.fields.find(({ id }) => id === "id")?.readOnly).toBe(true);
    expect(resource.fields.find(({ id }) => id === "ownerId")).toMatchObject({ label: "Owner", readOnly: false, relation: { optional: true } });
    expect(resource.recordActions).toMatchObject([{
      confirmation: "Confirm edit", feedback: { success: "Edited" },
      parameterFields: [{ id: "note", label: "Change note" }],
      action: { description: "Edit the selected resource." },
    }]);
  });

  it("rejects field operators whose kind cannot satisfy the collection contract", () => {
    expect(() => defineAtlasResource({ ...base, fields: { active: { filterable: ["contains"] } } }).toManifest())
      .toThrow('cannot use filter operator "contains" with kind "boolean"');
  });

  it("compiles a join-backed inverse collection and a bounded specialized lookup", () => {
    const resource = defineAtlasResource({
      ...base, fields: {
        ownerId: { relation: {
          ...owner,
          displayField: "name",
          lookup: { query: source.collectionQuery(list) },
          relatedRecords: {
            query: source.query(related), recordInput: "teamId", label: "Owned items", pageSize: 8,
            features: { sorting: false, recordActions: false },
          },
        } },
      },
    });
    const team = defineAtlasResource({ ...base, id: "team", label: "Teams" });
    const manifest = defineAtlas({ resources: [resource, team] }).getManifest();
    expect(manifest.resources[1]?.relatedCollections).toMatchObject([{
      id: "item.ownerId", label: "Owned items", recordInput: "teamId", pageSize: 8,
      query: { id: "resource:item:field:ownerId:related-records" },
      features: { search: true, filters: true, sorting: false, pagination: true, recordActions: false },
    }]);
    expect(resource.getOperationExposures()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "resource:item:field:ownerId:related-records", displayResourceId: "item", displayShape: "list" }),
      expect.objectContaining({ id: "resource:item:field:ownerId:lookup", collectionResourceId: "team", collectionConstraints: { firstPageOnly: true, maximumPageSize: 20, minimumSearchLength: 0 } }),
    ]));
  });

  it.each([
    [{ ...owner, displayField: "unknown" }, "references unknown target display field"],
    [{ ...owner, lookup: { minimumSearchLength: 2 } }, "requires searchable fields"],
    [owner, 'requires the "equals" filter or a related records Query'],
  ] satisfies readonly [NonNullable<NonNullable<AtlasResourceOptions["fields"]>[string]["relation"]>, string][])(
    "rejects unusable relation metadata before mounting (%s)", (relation, error) => {
      const item = defineAtlasResource({ ...base, fields: { ownerId: { relation } } });
      const team = defineAtlasResource({ ...base, id: "team", label: "Teams" });
      expect(() => defineAtlas({ resources: [item, team] })).toThrow(error);
    },
  );
});

describe("Atlas contextual operation gateway", () => {
  it("dispatches the exposed related query with its parent input and denies invalid or unauthorized calls", async () => {
    const item = defineAtlasResource({ ...base, fields: {
      ownerId: { relation: { ...owner, relatedRecords: { query: source.query(related), recordInput: "teamId" } } },
    }, recordActions: { edit: recordAction } });
    const team = defineAtlasResource({ ...base, id: "team", label: "Teams" });
    const atlas = defineAtlas({ basePath: "/admin", resources: [item, team] });
    const access = defineHttpMiddleware("atlas-resource-test-access", {
      handler: async ({ request }, next) => {
        if (request.headers.authorization !== "Bearer operator") throw new AuthenticationRequiredError();
        return next();
      },
    });
    const app = new App({});
    const server = Fastify();
    server.addHook("onReady", async () => app.start());
    relatedHandler.mockClear();
    try {
      const manager = new HttpControllerManager(app, server);
      for (const controller of atlas.defineHttpControllers({ required: [access] })) manager.register(controller);

      const operation = "resource:item:field:ownerId:related-records";
      const url = `/admin/api/operations/${encodeURIComponent(operation)}`;
      const headers = { authorization: "Bearer operator" };
      const pagination = { type: "page", page: 2, pageSize: 10 };
      const payload = { input: { pagination, teamId: "team-2" } };
      expect((await server.inject({ method: "POST", url, payload })).statusCode).toBe(401);
      expect((await server.inject({ method: "POST", url, headers, payload: { input: { pagination } } })).statusCode).toBe(400);
      expect(relatedHandler).not.toHaveBeenCalled();

      const success = await server.inject({ method: "POST", url, headers, payload });
      expect(success.statusCode).toBe(200);
      expect(success.json()).toEqual({ data: { items: [] }, effects: [] });
      expect(relatedHandler).toHaveBeenCalledExactlyOnceWith(payload.input, expect.anything());
      expect((await server.inject({ method: "POST", url: "/admin/api/resources/item/record-actions/unknown", headers, payload })).statusCode).toBe(404);
      expect((await server.inject({ method: "POST", url: "/admin/api/resources/item/record-actions/edit", headers, payload: { input: { id: "item-1" } } })).statusCode).toBe(400);
    } finally {
      await server.close();
      await app.dispose();
    }
  });
});

describe("Atlas collection capability validation", () => {
  const manifest = defineAtlasResource({ ...base, fields: {
    name: { sortable: true, filterable: ["contains"] },
    id: { filterable: ["in"] },
    metadata: { filterable: ["is-null"] },
  } }).toManifest();
  const schema = createResourceCollectionQuerySchema(manifest.fields);
  const pagination = { type: "page", page: 1, pageSize: 12 };

  it("accepts declared operators and sorting with valid operands", () => {
    expect(schema.safeParse({
      pagination, filters: [{ field: "id", operator: "in", value: ["1"] }, { field: "metadata", operator: "is-null" }],
      sorting: [{ field: "name", direction: "desc" }],
    }).success).toBe(true);
  });

  it("reports independent unsupported or malformed filters and sorting", () => {
    const result = schema.safeParse({
      pagination, search: "unsupported", filters: [
        { field: "constructor", operator: "equals", value: 0 },
        { field: "name", operator: "contains" },
        { field: "id", operator: "in", value: [] },
      ],
      sorting: [{ field: "id", direction: "asc" }, { field: "name", direction: "asc" }, { field: "name", direction: "desc" }],
    });
    expect(result.error?.issues.map(({ path }) => path)).toEqual([
      ["search"], ["filters", 0], ["filters", 1, "value"], ["filters", 2, "value"], ["sorting", 0], ["sorting", 2],
    ]);
  });
});
