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
const relatedWithoutSearch = defineAction({
  name: "resource.relatedWithoutSearch",
  input: relatedInput.omit({ search: true }),
  output: listOutput,
  handler: () => ({ items: [] }),
});
const invalidRead = defineAction({
  name: "resource.invalidRead", input: z.object({ id: z.string() }),
  output: z.string(), handler: () => "value",
});
const nullableFirstRead = defineAction({
  name: "resource.nullableFirstRead", input: z.object({ id: z.string() }),
  output: z.union([z.null(), row]), handler: () => null,
});
const otherSource = defineCatalogAtlasSource({ id: "other", actions: { read } });
const otherCollectionSource = defineCatalogAtlasSource({ id: "other-collections", actions: { related } });
const source = defineCatalogAtlasSource({
  id: "catalog", actions: { list, read, readMany, edit, related, relatedWithoutSearch, invalidRead, nullableFirstRead },
});
const capabilities = { list: source.collectionQuery(list), read: source.query(read), readMany: source.query(readMany) };
const base: AtlasResourceOptions = { id: "item", label: "Items", source, identity: "id", capabilities };
const owner = { resource: "team", cardinality: "one" } as const;
const recordAction = { label: "Edit", action: source.action(edit), recordInput: "id" };

describe("Atlas resource declarations", () => {
  it.each([
    [{ id: "Invalid Resource" }, "resource id"],
    [{ label: " " }, "resource label cannot be empty"],
    [{ identity: " " }, "resource identity cannot be empty"],
    [{ identity: "missing" }, 'identity "missing" does not exist'],
    [{ identity: "constructor" }, 'identity "constructor" does not exist'],
    [{ capabilities: { ...capabilities, read: source.query(invalidRead) } }, 'identity "id" does not exist'],
    [{ displayField: "toString" }, 'display field "toString" does not exist'],
    [{ display: "name", displayField: "id" }, "Use either display or displayField"],
    [{ readManyBatchSize: 0 }, "readManyBatchSize must be a positive safe integer"],
    [{ fields: { __atlas_display: {} } }, "__atlas_display field is reserved"],
    [{ navigationGroup: " " }, "navigation group label cannot be empty"],
    [{ recordLinks: { detail: { label: " ", href: () => "/item" } } }, "record link label cannot be empty"],
    [{ recordLinks: { "Invalid link": { label: "Details", href: () => "/item" } } }, "record link id"],
    [{ capabilities: { ...capabilities, read: otherSource.query(read) } }, 'operation from source "other"'],
    [{ capabilities: { ...capabilities, list: source.action(list) } }, "list capability must reference a Query"],
    [{ capabilities: { ...capabilities, read: source.action(read) } }, "read capability must reference a Query"],
    [{ capabilities: { ...capabilities, readMany: source.action(readMany) } }, "readMany capability must reference a Query"],
    [{ capabilities: { ...capabilities, readMany: source.query(read) } }, 'readMany capability must accept an "ids" input'],
    [{ capabilities: { ...capabilities, create: source.query(edit) } }, "create capability must reference an Action"],
    [{ capabilities: { ...capabilities, update: source.query(edit) } }, "update capability must reference an Action"],
    [{ capabilities: { ...capabilities, delete: source.query(edit) } }, "delete capability must reference an Action"],
    [{ capabilities: { ...capabilities, history: source.query(list) } }, "must reference a Query accepting an id input"],
    [{ capabilities: { ...capabilities, history: source.action(read) } }, "must reference a Query accepting an id input"],
    [{ views: { preview: { label: " ", query: source.query(read) } } }, "non-empty label"],
    [{ views: { "Invalid view": { label: "Preview", query: source.query(read) } } }, "Atlas view id"],
    [{ views: { preview: { label: "Preview", query: source.action(read) } } }, "must reference a Query"],
    [{ views: { preview: { label: "Preview", query: source.query(read), renderer: "Invalid Renderer" } } }, "view renderer id"],
    [{ recordActions: { edit: { ...recordAction, label: " " } } }, "non-empty label"],
    [{ recordActions: { "Invalid action": recordAction } }, "Atlas record action id"],
    [{ recordActions: { edit: { ...recordAction, action: source.query(edit) } } }, "must reference an Action"],
    [{ recordActions: { edit: { ...recordAction, recordInput: "absent" } } }, 'input "absent" does not exist'],
    [{ recordActions: { edit: { ...recordAction, inputs: { absent: {} } } } }, 'references unknown input "absent"'],
    [{ recordActions: { edit: { ...recordAction, inputs: { id: {} } } } }, 'cannot configure its bound record input "id"'],
    [{ recordActions: { edit: { ...recordAction, inputs: { note: { kind: "relation" } } } } }, "must define its target relation"],
    [{ recordActions: { edit: { ...recordAction, feedback: { error: " " } } } }, "feedback message"],
  ] satisfies readonly [Partial<AtlasResourceOptions>, string][])("rejects invalid resource metadata (case %#)", (overrides, message) => {
    expect(() => defineAtlasResource({ ...base, ...overrides }).toManifest()).toThrow(message);
  });

  it.each([
    [{ kind: "relation" }, "must define its target relation"],
    [{ kind: "number", relation: owner }, 'cannot combine kind "number" with a relation'],
    [{ relation: { ...owner, resource: " " } }, "must reference a Resource"],
    [{ relation: { ...owner, lookup: { pageSize: 0 } } }, "lookup page size"],
    [{ relation: { ...owner, lookup: { pageSize: 1.5 } } }, "lookup page size"],
    [{ relation: { ...owner, lookup: { pageSize: 101 } } }, "lookup page size"],
    [{ relation: { ...owner, lookup: { query: { ...source.collectionQuery(list), effect: "write" } } } }, "lookup must reference a Query"],
    [{ relation: { ...owner, lookup: { minimumSearchLength: -1 } } }, "lookup minimum search length"],
    [{ relation: { ...owner, lookup: { minimumSearchLength: 0.5 } } }, "lookup minimum search length"],
    [{ relation: { ...owner, relatedRecords: { pageSize: 0 } } }, "related records page size"],
    [{ relation: { ...owner, relatedRecords: { pageSize: 101 } } }, "related records page size"],
    [{ relation: { ...owner, relatedRecords: { pageSize: 2.5 } } }, "related records page size"],
    [{ relation: { ...owner, relatedRecords: { label: " " } } }, "related records label cannot be empty"],
    [{ relation: { ...owner, inverseCardinality: "one", relatedRecords: {} } }, "inverse cardinality"],
    [{ relation: { ...owner, relatedRecords: { query: source.action(related) } } }, "related records operation must reference a Query"],
    [{ relation: { ...owner, relatedRecords: { query: source.query(related) } } }, "must define its record input"],
    [{ relation: { ...owner, relatedRecords: { query: source.query(related), recordInput: "pagination" } } }, "reserved"],
    [{ relation: { ...owner, relatedRecords: { query: source.query(related), recordInput: "unknown" } } }, 'input "unknown" does not exist'],
    [{ relation: { ...owner, relatedRecords: { query: source.query(read), recordInput: "id" } } }, 'must accept a "pagination" input'],
    [{ relation: { ...owner, relatedRecords: { query: source.query(relatedWithoutSearch), recordInput: "teamId" } } }, 'enables search but its related records Query does not accept a "search" input'],
    [{ relation: { ...owner, relatedRecords: { recordInput: "teamId" } } }, "without a Query"],
  ] satisfies readonly [NonNullable<AtlasResourceOptions["fields"]>[string], string][])("validates relation declarations (case %#)", (field, message) => {
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
      parameterFields: [{ id: "note", label: "Change note", kind: "text", readOnly: false, hidden: false, schema: { type: "string" } }],
      action: { description: "Edit the selected resource." },
    }]);
  });

  it("rejects field operators whose kind cannot satisfy the collection contract", () => {
    expect(() => defineAtlasResource({ ...base, fields: { active: { filterable: ["contains"] } } }).toManifest())
      .toThrow('cannot use filter operator "contains" with kind "boolean"');
  });

  it("preserves supported scalar and identifier filter operators in declaration order", () => {
    const fields = {
      name: { filterable: ["equals", "not-equals", "contains", "starts-with"] },
      ownerId: { relation: { ...owner, relatedRecords: false }, filterable: ["equals", "not-equals", "in", "not-in"] },
      amount: { filterable: ["equals", "not-equals", "less-than", "less-than-or-equal", "greater-than", "greater-than-or-equal"] },
    } as const satisfies AtlasResourceOptions["fields"];
    const resource = defineAtlasResource({ ...base, fields }).toManifest();
    for (const [id, options] of Object.entries(fields)) {
      expect(resource.fields.find((field) => field.id === id)?.filterOperators).toEqual(options.filterable);
    }
    expect(() => defineAtlasResource({ ...base, fields: { name: { filterable: ["is-null"] } } }).toManifest())
      .toThrow('cannot use filter operator "is-null" with kind "text"');
  });

  it("infers optional union relations and trims only terminal identifier suffixes in labels", () => {
    const schema = row.extend({
      "coordinator-id": z.union([z.int(), z.null()]),
      "reviewer-id-region": z.xor([z.int(), z.null()]),
      "follower-ids": z.array(z.string()),
      requestIdsForAudit: z.union([z.string(), z.int()]),
    });
    const unionRead = defineAction({ name: "resource.union", input: read.inputSchema, output: schema, handler: () => { throw new Error("Metadata only"); } });
    const unionSource = defineCatalogAtlasSource({ id: "catalog", actions: { list, readMany, unionRead } });
    const resource = defineAtlasResource({ ...base, source: unionSource,
      capabilities: { ...capabilities, read: unionSource.query(unionRead) },
      fields: {
        "coordinator-id": { relation: { ...owner, relatedRecords: false } },
        "reviewer-id-region": { relation: { ...owner, relatedRecords: false } },
        "follower-ids": { relation: { ...owner, cardinality: "many", relatedRecords: false } },
        requestIdsForAudit: { relation: { ...owner, relatedRecords: false } },
      },
    }).toManifest();
    const byId = new Map(resource.fields.map((field) => [field.id, field]));
    expect(byId.get("coordinator-id")).toMatchObject({ label: "Coordinator", relation: { optional: true } });
    expect(byId.get("reviewer-id-region")).toMatchObject({ label: "Reviewer id region", relation: { optional: true } });
    expect(byId.get("follower-ids")).toMatchObject({ label: "Follower", relation: { optional: false } });
    expect(byId.get("requestIdsForAudit")).toMatchObject({ label: "Request Ids For Audit", relation: { optional: false } });
    expect(byId.get("coordinator-id")?.relation).not.toHaveProperty("displayField");
    expect(byId.get("ownerId")?.label).toBe("Owner Id");
  });

  it("describes Action parameters using the shape sent by the browser before input transforms", () => {
    const transform = defineAction({
      name: "resource.transform",
      input: z.object({ id: z.string(), note: z.string() }).transform(({ id, note }) => ({ target: id, memo: note })),
      output: z.string(), handler: ({ memo }) => memo,
    });
    const transformSource = defineCatalogAtlasSource({ id: "catalog", actions: { transform } });
    const resource = defineAtlasResource({ ...base, source: transformSource, recordActions: {
      note: { label: "Attach note", recordInput: "id", action: transformSource.action(transform), inputs: { note: {} } },
    } }).toManifest();
    expect(resource.recordActions[0]).toMatchObject({
      recordInput: "id", action: { inputs: [{ id: "id", required: true }, { id: "note", required: true }] },
      parameterFields: [{ id: "note", kind: "text", schema: { type: "string" } }],
    });
  });

  it("replaces only the lookup suffix when compiling contextual collection exposure IDs", () => {
    const id = "scope:lookupOwner";
    const resource = defineAtlasResource({ ...base, fields: { [id]: { relation: {
      ...owner, relatedRecords: { query: source.query(related), recordInput: "teamId" },
    } } } });
    expect(resource.toManifest().fields.find((field) => field.id === id)?.relation?.relatedRecords)
      .toMatchObject({ query: { id: `resource:item:field:${id}:related-records` } });
    expect(resource.getOperationExposures()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `resource:item:field:${id}:related-records` }),
    ]));
  });

  it("distinguishes defaulted request fields from response fields and omits unconfigured Action metadata", () => {
    const shape = z.object({ id: z.string(), note: z.string().default("Saved") });
    const save = defineAction({ name: "resource.save", input: shape, output: shape, handler: (input) => input });
    const actionSource = defineCatalogAtlasSource({ id: "catalog", actions: { list, read, readMany, save } });
    const manifest = defineAtlasResource({ ...base, source: actionSource, recordActions: {
      save: { label: "Save", recordInput: "id", action: actionSource.action(save) },
    } }).toManifest();
    const action = manifest.recordActions[0]!;
    expect(action.action).toMatchObject({
      id: "resource:item:record-action:save",
      inputs: [{ id: "id", required: true }, { id: "note", required: false }],
      outputSchema: { additionalProperties: false, required: ["id", "note"] },
    });
    for (const field of ["showInList", "confirmation", "feedback", "parameterFields"]) {
      expect(action).not.toHaveProperty(field);
    }
    expect(action.action).not.toHaveProperty("description");
  });

  it("rejects foreign contextual queries before compiling a Resource", () => {
    expect(() => defineAtlasResource({ ...base, fields: { ownerId: { relation: {
      ...owner, relatedRecords: { query: otherCollectionSource.query(related), recordInput: "teamId" },
    } } } })).toThrow('contains an operation from source "other-collections"');
  });

  it("reserves computed display metadata in catalog output and Resource options", () => {
    const reserved = defineAction({
      name: "resource.reserved", input: read.inputSchema,
      output: row.extend({ __atlas_display: z.string() }).nullable(), handler: () => null,
    });
    const reservedSource = defineCatalogAtlasSource({ id: "catalog", actions: { list, reserved, readMany } });
    expect(() => defineAtlasResource({ ...base, source: reservedSource, capabilities: {
      list: reservedSource.collectionQuery(list), read: reservedSource.query(reserved), readMany: reservedSource.query(readMany),
    } }).toManifest()).toThrow("The __atlas_display field is reserved");
  });

  it("omits optional Resource metadata and avoids synthesizing Action lookups", () => {
    const resource = defineAtlasResource({ ...base, recordActions: { edit: {
      ...recordAction, inputs: { note: { label: "Note" } },
    } } });
    expect(resource).not.toHaveProperty("icon");
    expect(resource.toManifest()).not.toHaveProperty("readManyBatchSize");
    expect(resource.toManifest()).not.toHaveProperty("recordActionsInList");
    expect(resource.toManifest().recordActions[0]?.parameterFields).toMatchObject([{ id: "note", label: "Note" }]);
    expect(resource.getOperationExposures()).toEqual([
      expect.objectContaining({ id: "resource:item:list" }),
      expect.objectContaining({ id: "resource:item:read" }),
      expect.objectContaining({ id: "resource:item:read-many" }),
    ]);
    expect(resource.getOperationExposures()[1]).not.toHaveProperty("resolveRecordLinks");

    const relatedAction = defineAtlasResource({ ...base, fields: { ownerId: { relation: {
      ...owner, relatedRecords: false,
    } } }, recordActions: { edit: { ...recordAction, inputs: { ownerId: {} } } } });
    expect(relatedAction.getOperationExposures().map(({ id }) => id))
      .toEqual(["resource:item:list", "resource:item:read", "resource:item:read-many"]);
  });

  it("uses an empty schema for presentation fields absent from the read schema", () => {
    const manifest = defineAtlasResource({
      ...base,
      fields: { constructor: { label: "Constructor metadata" } },
    }).toManifest();

    // The manifest is a JSON contract, including fields named after inherited properties.
    expect(JSON.parse(JSON.stringify(manifest)).fields).toContainEqual(expect.objectContaining({
      id: "constructor", label: "Constructor metadata", kind: "json", schema: {},
    }));
  });

  it("keeps explicit field, view and Action metadata separate from inferred defaults", () => {
    const resource = defineAtlasResource({
      ...base,
      label: "People",
      labelSingular: "Person",
      navigationGroup: "  Admin  ",
      display: "name",
      recordActionsInList: "none",
      capabilities: { ...capabilities, create: source.action(edit), update: source.action(edit) },
      fields: {
        name: { label: "Public name", hidden: true, searchable: true, sortable: true, filterable: false },
        note: { readOnly: true },
        ownerId: { relation: {
          ...owner, inverseCardinality: "one", optional: false, displayField: "name",
          lookup: { query: source.collectionQuery(list), pageSize: 100, minimumSearchLength: 2 },
        } },
      },
      views: { preview: { label: "Preview", query: source.query(read), renderer: "custom" } },
      recordActions: { edit: {
        ...recordAction, showInList: true, presentation: "page",
        inputs: { note: { label: "Note" }, ownerId: { label: "Approver" } },
      } },
    });
    const manifest = resource.toManifest();
    expect(resource.getDisplay?.()).toBeUndefined();
    expect(resource.readManyBatchSize).toBe(100);
    expect(manifest).toMatchObject({
      label: "People", labelSingular: "Person", navigationGroup: "Admin", displayField: "name",
      recordActionsInList: "none",
      views: [{ id: "preview", label: "Preview", renderer: "custom", query: { id: "resource:item:view:preview" } }],
      recordActions: [{ id: "edit", showInList: true, presentation: "page", parameterFields: [
        { id: "note", label: "Note", readOnly: true },
        { id: "ownerId", label: "Approver", kind: "relation", relation: {
          inverseCardinality: "one", optional: false, displayField: "name", lookup: {
            pageSize: 100, minimumSearchLength: 2,
            operation: { id: "resource:item:record-action:edit:input:ownerId:lookup" },
          },
        } },
      ] }],
    });
    expect(manifest.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "name", label: "Public name", hidden: true, searchable: true, sortable: true, filterOperators: [] }),
      expect.objectContaining({ id: "note", readOnly: true }),
    ]));
    expect(manifest.recordActions[0]!.action.inputs.map(({ id, required }) => [id, required]))
      .toEqual([["id", true], ["note", true], ["ownerId", false]]);
    expect(manifest.recordActions[0]!.action.outputSchema).toMatchObject({
      anyOf: expect.arrayContaining([expect.objectContaining({ type: "null" })]),
    });
    expect(resource.getOperationExposures()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "resource:item:read", displayShape: "record", displayResourceId: "item" }),
      expect.objectContaining({ id: "resource:item:read-many", displayShape: "array", displayResourceId: "item" }),
      expect.objectContaining({ id: "resource:item:list", displayShape: "list", displayResourceId: "item", collectionResourceId: "item" }),
      expect.objectContaining({ id: "resource:item:field:ownerId:lookup", collectionConstraints: { maximumPageSize: 100, minimumSearchLength: 2, firstPageOnly: true } }),
      expect.objectContaining({ id: "resource:item:record-action:edit:input:ownerId:lookup", collectionConstraints: { maximumPageSize: 100, minimumSearchLength: 2, firstPageOnly: true } }),
    ]));
  });

  it("compiles computed labels and preserves exact capability exposure boundaries", () => {
    const display = { select: { title: "name" }, format: (values: Readonly<Record<string, unknown>>) => String(values.title) } as const;
    const resource = defineAtlasResource({
      ...base,
      display,
      readManyBatchSize: 1,
      capabilities: {
        ...capabilities,
        create: source.action(edit),
        update: source.action(edit),
        delete: source.action(edit),
        history: source.query(read),
      },
      fields: { name: { sortable: true }, ownerId: { relation: { ...owner, relatedRecords: false } } },
      recordLinks: { detail: { label: "Details", href: () => "/item" } },
      recordActions: { edit: recordAction },
      views: { preview: { label: "Preview", query: source.query(read) } },
    });
    expect(resource.getDisplay?.()).toBe(display);
    expect(resource.readManyBatchSize).toBe(1);
    const manifest = resource.toManifest();
    expect(manifest).toMatchObject({
      displayField: "__atlas_display", labelSingular: "Item", relatedCollections: [],
      capabilities: {
        history: { id: "resource:item:history", effect: "read" },
        create: { id: "resource:item:create", effect: "write" },
        read: { id: "resource:item:read", effect: "read" },
        update: { id: "resource:item:update", effect: "write" },
        delete: { id: "resource:item:delete", effect: "destructive" },
      },
    });
    expect(manifest.fields[0]).toStrictEqual({
      id: "__atlas_display", label: "Label", kind: "text", schema: { type: "string" },
      hidden: false, readOnly: true, searchable: false, filterOperators: [], sortable: false,
    });
    const byId = new Map(resource.getOperationExposures().map((exposure) => [exposure.id, exposure]));
    expect(byId.get("resource:item:read")).toHaveProperty("resolveRecordLinks");
    expect(byId.get("resource:item:read-many")).not.toHaveProperty("resolveRecordLinks");
    expect(byId.get("resource:item:history")).not.toHaveProperty("displayShape");
    expect(byId.get("resource:item:view:preview")?.reference.operation).toBe(read);
    const listExposure = byId.get("resource:item:list")!;
    const pagination = { type: "page", page: 1, pageSize: 20 };
    expect(listExposure.inputSchema.safeParse({ pagination, sorting: [{ field: "id", direction: "asc" }] }).success).toBe(false);
    expect(listExposure.inputSchema.safeParse({ pagination, sorting: [{ field: "name", direction: "desc" }] }).success).toBe(true);
    expect(byId.get("resource:item:read")?.inputSchema.safeParse({ id: "one" }).success).toBe(true);
    expect(byId.get("resource:item:read")?.inputSchema.safeParse({ pagination }).success).toBe(false);
  });

  it("finds the object after a null alternative and allows list-backed related records", () => {
    const item = defineAtlasResource({
      ...base,
      capabilities: { ...capabilities, read: source.query(nullableFirstRead) },
      fields: {
        ownerId: { filterable: ["equals"], relation: { ...owner, relatedRecords: { pageSize: 4 } } },
      },
    });
    const team = defineAtlasResource({ ...base, id: "team", label: "Teams" });
    const [manifest] = defineAtlas({ resources: [item, team] }).getManifest().resources;

    expect(manifest?.fields.find(({ id }) => id === "ownerId")).toMatchObject({
      kind: "relation", filterOperators: ["equals"],
      relation: { optional: true, relatedRecords: {
        pageSize: 4, features: { search: true, filters: true, sorting: true, pagination: true, recordActions: true },
      } },
    });
    const related = manifest?.fields.find(({ id }) => id === "ownerId")?.relation?.relatedRecords;
    expect(related).not.toHaveProperty("label");
    expect(related).not.toHaveProperty("recordInput");
    expect(manifest?.relatedCollections).toEqual([]);
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
      expect.objectContaining({ id: "resource:item:field:ownerId:lookup", collectionResourceId: "team", displayShape: "list", collectionConstraints: { firstPageOnly: true, maximumPageSize: 20, minimumSearchLength: 0 } }),
    ]));
  });

  it.each([
    [{ ...owner, displayField: "unknown" }, "references unknown target display field"],
    [{ ...owner, lookup: { minimumSearchLength: 2 } }, "requires searchable fields"],
    [owner, 'requires the "equals" filter or a related records Query'],
  ] satisfies readonly [NonNullable<NonNullable<AtlasResourceOptions["fields"]>[string]["relation"]>, string][])(
    "rejects unusable relation metadata before mounting (case %#)", (relation, error) => {
      const item = defineAtlasResource({ ...base, fields: { ownerId: { relation } } });
      const team = defineAtlasResource({ ...base, id: "team", label: "Teams" });
      expect(() => defineAtlas({ resources: [item, team] })).toThrow(error);
    },
  );
});

describe("Atlas relation configuration boundaries", () => {
  it.each([1, 100])("allows the page-size endpoint %i for lookup and related records", (pageSize) => {
    const resource = defineAtlasResource({
      ...base, fields: {
        ownerId: { relation: {
          ...owner,
          lookup: { pageSize, minimumSearchLength: 0 },
          relatedRecords: { label: "Records for this owner", pageSize },
        } },
      },
    }).toManifest();
    expect(resource.fields.find(({ id }) => id === "ownerId")?.relation).toMatchObject({
      lookup: { pageSize, minimumSearchLength: 0 },
      relatedRecords: { label: "Records for this owner", pageSize },
    });
  });

  it.each([
    ["search", relatedInput.omit({ search: true })],
    ["filters", relatedInput.omit({ filters: true })],
    ["sorting", relatedInput.omit({ sorting: true })],
  ] as const)(
    "allows a contextual Query without %s only when the feature is disabled",
    (feature, input) => {
      const query = defineAction({
        name: `resource.missing-${feature}`,
        input, output: listOutput,
        handler: () => ({ items: [] }),
      });
      const querySource = defineCatalogAtlasSource({ id: source.id, actions: { query } });
      const explicit = {
        ...owner, relatedRecords: { query: querySource.query(query), recordInput: "teamId" },
      };
      expect(() => defineAtlasResource({ ...base, fields: { ownerId: { relation: explicit } } })).toThrow(
        `enables ${feature} but its related records Query does not accept a "${feature}" input.`,
      );
      const valid = defineAtlasResource({
        ...base, fields: {
          ownerId: { relation: {
            ...explicit,
            relatedRecords: {
              ...explicit.relatedRecords,
              features: { search: true, filters: true, sorting: true, [feature]: false },
            },
          } },
        },
      }).toManifest();
      expect(valid.fields.find(({ id }) => id === "ownerId")?.relation?.relatedRecords)
        .toMatchObject({ recordInput: "teamId", features: { [feature]: false } });
    },
  );

  it("allows inverse-one relations to disable a related collection explicitly", () => {
    const resource = defineAtlasResource({
      ...base, fields: {
        ownerId: { relation: { ...owner, inverseCardinality: "one", relatedRecords: false } },
      },
    }).toManifest();
    expect(resource.fields.find(({ id }) => id === "ownerId")?.relation)
      .toMatchObject({ inverseCardinality: "one", relatedRecords: false });
  });
});

describe("Atlas resource record links", () => {
  function resolveLink(href: string) {
    const resource = defineAtlasResource({
      ...base, recordLinks: { detail: { label: "Details", href: () => href } },
    });
    const exposure = resource.getOperationExposures().find(({ id }) => id === "resource:item:read");
    return exposure!.resolveRecordLinks!({ id: "item-1" });
  }

  it.each([
    "/items/one%20two", "https://example.test/items/1", "http://example.test/items/1",
  ])("preserves a valid record link %s", (href) => {
    expect(resolveLink(href)).toEqual([{ id: "detail", label: "Details", href }]);
  });

  it.each([
    "//example.test/item", "javascript:alert(1)", "/\\example.test", "/two words",
    "/tab\titem", "/delete\u007fitem", "/nonbreaking\u00a0space", " /item",
  ])("rejects an unsafe or unescaped record link %j", (href) => {
    expect(() => resolveLink(href)).toThrow('Atlas record link "detail" returned an invalid URL.');
  });
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
      const invalidInput = await server.inject({ method: "POST", url, headers, payload: { input: { pagination } } });
      expect(invalidInput.statusCode).toBe(400);
      expect(invalidInput.json()).toMatchObject({
        statusCode: 400, error: "Bad Request", message: "The request input is invalid.",
        issues: [expect.objectContaining({ path: ["teamId"] })],
      });
      const missingOperation = await server.inject({ method: "POST", url: "/admin/api/operations/unknown", headers, payload });
      expect(missingOperation.statusCode).toBe(404);
      expect(missingOperation.json()).toEqual({ error: "Atlas operation not found." });
      expect(relatedHandler).not.toHaveBeenCalled();

      const success = await server.inject({ method: "POST", url, headers, payload });
      expect(success.statusCode).toBe(200);
      expect(success.json()).toEqual({ data: { items: [] }, effects: [] });
      expect(relatedHandler).toHaveBeenCalledExactlyOnceWith(payload.input, expect.anything());
      const missingAction = await server.inject({ method: "POST", url: "/admin/api/resources/item/record-actions/unknown", headers, payload });
      expect(missingAction.statusCode).toBe(404);
      expect(missingAction.json()).toEqual({ error: "Atlas record Action not found." });
      const invalidAction = await server.inject({ method: "POST", url: "/admin/api/resources/item/record-actions/edit", headers, payload: { input: { id: "item-1" } } });
      expect(invalidAction.statusCode).toBe(400);
      expect(invalidAction.json()).toMatchObject({
        statusCode: 400, error: "Bad Request", message: "The request input is invalid.",
        issues: [expect.objectContaining({ path: ["note"] })],
      });
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
