import { describe, expect, it } from "vitest";
import { z } from "zod";

import { uuidV7 } from "../utils/uuid.js";
import { defineAction } from "../actions/index.js";
import { AtlasLoginRequiredError } from "./errors.js";
import {
  defineCatalogAtlasSource,
  defineAtlas,
  defineAtlasRecordAction,
  defineAtlasResource,
  defineAtlasResourceView,
  type SvgIconDefinition,
} from "./index.js";

const exampleIcon: SvgIconDefinition = {
  type: "svg",
  viewBox: [0, 0, 16, 16],
  paths: [{ d: "M1 1h14v14H1z" }],
};

const modelSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  active: z.boolean(),
  createdAt: z.date(),
});
const identifierSchema = modelSchema.pick({ id: true });
const writeSchema = z.object({ email: z.email() });
const updateSchema = identifierSchema.extend(writeSchema.partial().shape);
const listQuery = defineAction({
  name: "example.list",
  input: z.object({ page: z.number().default(1) }),
  output: z.object({
    items: z.array(modelSchema),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
  handler: () => ({ items: [], pageInfo: { hasNextPage: false } }),
});
const readQuery = defineAction({
  name: "example.get",
  input: identifierSchema,
  output: modelSchema.nullable(),
  handler: () => null,
});
const readManyQuery = defineAction({
  name: "example.getMany",
  input: z.object({ ids: z.array(z.uuid()) }),
  output: z.array(modelSchema),
  handler: () => [],
});
const createAction = defineAction({
  name: "example.create",
  input: writeSchema,
  output: modelSchema,
  handler: ({ email }) => ({
    id: uuidV7(),
    email,
    active: true,
    createdAt: new Date(),
  }),
});
const updateAction = defineAction({
  name: "example.update",
  input: updateSchema,
  output: modelSchema.nullable(),
  handler: () => null,
});
const deleteAction = defineAction({
  name: "example.delete",
  input: identifierSchema,
  output: modelSchema.nullable(),
  handler: () => null,
});
const activeQuery = defineAction({
  name: "example.listActive",
  input: z.object({ page: z.number().default(1) }),
  output: listQuery.outputSchema,
  handler: () => ({ items: [], pageInfo: { hasNextPage: false } }),
});
const fillNameAction = defineAction({
  name: "example.fillName",
  input: identifierSchema,
  output: modelSchema.nullable(),
  handler: () => null,
});
const sendMessageAction = defineAction({
  name: "example.sendMessage",
  input: identifierSchema.extend({ message: z.string().min(1) }),
  output: modelSchema.nullable(),
  handler: () => null,
});
const catalog = {
  list: listQuery,
  get: readQuery,
  getMany: readManyQuery,
  create: createAction,
  update: updateAction,
  delete: deleteAction,
  active: activeQuery,
  fillName: fillNameAction,
  sendMessage: sendMessageAction,
};

function createAtlas(textMaxLength?: number | false, resourceLimit?: number | false) {
  const source = defineCatalogAtlasSource({
    id: "application",
    actions: catalog,
  });
  const resource = defineAtlasResource({
    id: "example",
    label: "Examples",
    icon: exampleIcon,
    source,
    identity: "id",
    recordActionsInList: "all",
    ...(resourceLimit === undefined ? {} : { textMaxLength: resourceLimit }),
    capabilities: {
      list: source.query(catalog.list),
      read: source.query(catalog.get),
      readMany: source.query(catalog.getMany),
      create: source.action(catalog.create),
      update: source.action(catalog.update),
      delete: source.action(catalog.delete),
    },
    fields: {
      email: { label: "Email address" },
    },
    views: {
      active: defineAtlasResourceView({
        label: "Active examples",
        query: source.query(catalog.active),
      }),
    },
    recordActions: {
      "fill-name": defineAtlasRecordAction({
        label: "Fill name",
        action: source.action(catalog.fillName),
        recordInput: "id",
        presentation: "page",
      }),
      "send-message": defineAtlasRecordAction({
        label: "Send message",
        action: source.action(catalog.sendMessage),
        recordInput: "id",
        inputs: {
          message: {
            label: "Recipient",
            relation: {
              resource: "example",
              cardinality: "one",
              lookup: {
                query: source.collectionQuery(catalog.list),
                pageSize: 8,
              },
            },
          },
        },
        showInList: false,
      }),
    },
  });

  return defineAtlas({
    title: "Example Atlas workspace",
    basePath: "/management/",
    defaults: { recordActionsInList: "none", ...(textMaxLength === undefined ? {} : { textMaxLength }) },
    notifications: { position: "top-right" },
    resources: [resource],
  });
}

describe("Atlas", () => {
  it("represents required login as a non-cacheable browser redirect", () => {
    const location = "/management/login?returnTo=%2Fmanagement";
    const error = new AtlasLoginRequiredError(location);
    expect(error).toMatchObject({ name: "AtlasLoginRequiredError", message: "Atlas login is required." });
    expect(error.toHttpError({ executionId: "test-login" })).toEqual({
      statusCode: 302, message: "Atlas login is required.", headers: { location, "cache-control": "no-store" },
    });
  });

  it.each(["//external.test", "/\\external.test"])("rejects a cross-origin mount path %s", (basePath) => {
    expect(() => defineAtlas({ basePath, resources: [] })).toThrow("absolute URL path");
  });

  it.each(["/backoffice/../admin", "/backoffice/%2e%2E/admin", "/backoffice/:tenant"])(
    "rejects a mount path that would be interpreted differently by the browser or router (%s)",
    (basePath) => {
      expect(() => defineAtlas({ basePath, resources: [] })).toThrow("absolute URL path");
    },
  );

  it("canonicalizes whitespace and every trailing slash in the configured mount", () => {
    const atlas = defineAtlas({ basePath: "  /backoffice/admin///  ", resources: [] });
    expect(atlas.getManifest().basePath).toBe("/backoffice/admin");
    expect(defineAtlas({ basePath: " / ", resources: [] }).getManifest().basePath).toBe("/");
  });

  it("serializes default and resource list text limits without losing false", () => {
    expect(createAtlas().getManifest().defaults.textMaxLength).toBe(50);
    expect(createAtlas(80, 100).getManifest()).toMatchObject({
      defaults: { textMaxLength: 80 }, resources: [{ textMaxLength: 100 }],
    });
    expect(createAtlas(false, false).getManifest()).toMatchObject({
      defaults: { textMaxLength: false }, resources: [{ textMaxLength: false }],
    });
    expect(createAtlas().getManifest().resources[0]).not.toHaveProperty("textMaxLength");
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid list limits: %s", (limit) => {
    expect(() => createAtlas(limit)).toThrow("textMaxLength");
    expect(() => createAtlas(undefined, limit)).toThrow("textMaxLength");
  });

  it("compiles explicitly mapped resources into a serializable manifest", () => {
    const manifest = createAtlas().getManifest();
    const resource = manifest.resources[0]!;

    expect(manifest.basePath).toBe("/management");
    expect(manifest.title).toBe("Example Atlas workspace");
    expect(manifest.defaults.recordActionsInList).toBe("none");
    expect(manifest.notifications.position).toBe("top-right");
    expect(resource.id).toBe("example");
    expect(resource.displayField).toBe("id");
    expect(resource.recordActionsInList).toBe("all");
    expect(resource.icon).toBe("icon-1");
    expect(manifest.icons).toEqual({ "icon-1": exampleIcon });
    expect(resource.capabilities.list).toMatchObject({
      id: "resource:example:list",
      sourceId: "application",
      effect: "read",
    });
    expect(resource.capabilities.update!.inputs).toEqual([
      expect.objectContaining({ id: "id" }),
      expect.objectContaining({ id: "email" }),
    ]);
    expect(resource.capabilities.readMany).toMatchObject({
      id: "resource:example:read-many",
      effect: "read",
      inputs: [expect.objectContaining({ id: "ids" })],
    });
    expect(resource.capabilities.delete!.effect).toBe("destructive");
    expect(resource.views).toEqual([
      expect.objectContaining({
        id: "active",
        label: "Active examples",
        renderer: "resource-list",
      }),
    ]);
    expect(resource.recordActions).toEqual([
      expect.objectContaining({
        id: "fill-name",
        label: "Fill name",
        recordInput: "id",
        presentation: "page",
      }),
      expect.objectContaining({
        id: "send-message",
        presentation: "dialog",
        showInList: false,
        parameterFields: [expect.objectContaining({
          id: "message",
          label: "Recipient",
          kind: "relation",
          relation: expect.objectContaining({
            resource: "example",
            cardinality: "one",
            lookup: expect.objectContaining({
              pageSize: 8,
              operation: expect.objectContaining({
                id: "resource:example:record-action:send-message:input:message:lookup",
              }),
            }),
          }),
        })],
        action: expect.objectContaining({
          inputs: [
            expect.objectContaining({ id: "id" }),
            expect.objectContaining({ id: "message" }),
          ],
        }),
      }),
    ]);
    expect(resource.fields).toEqual([
      expect.objectContaining({ id: "id", kind: "id", readOnly: true }),
      expect.objectContaining({
        id: "email",
        label: "Email address",
        kind: "email",
        readOnly: false,
      }),
      expect.objectContaining({ id: "active", kind: "boolean" }),
      expect.objectContaining({ id: "createdAt", kind: "datetime" }),
    ]);
    expect(() => JSON.stringify(manifest)).not.toThrow();
  });

  it("places notifications at the bottom left by default", () => {
    const configured = createAtlas();
    const atlas = defineAtlas({
      resources: configured.resources,
    });

    expect(atlas.getManifest().notifications.position)
      .toBe("bottom-left");
  });

  it("applies the workspace title and visibility defaults before compiling the manifest", () => {
    const atlas = defineAtlas({ title: "  Review workspace  ", resources: [] });
    expect(atlas.getManifest()).toMatchObject({ title: "Review workspace", defaults: { recordActionsInList: "all" } });
    expect(defineAtlas({ title: "  ", resources: [] }).getManifest().title).toBe("Atlas");
    expect(atlas.getManifest()).not.toHaveProperty("history");
    expect(atlas.getManifest()).not.toHaveProperty("branding");
  });

  it("reuses the compiled manifest for repeated consumers", () => {
    const [resource] = createAtlas().resources;
    let compiled = 0;
    const atlas = defineAtlas({ resources: [{ ...resource!, toManifest: () => {
      compiled += 1;
      return resource!.toManifest();
    } }] });
    const afterRegistration = compiled;
    expect(afterRegistration).toBeGreaterThan(0);
    expect(atlas.getManifest().resources[0]?.id).toBe("example");
    expect(atlas.getManifest().resources[0]?.id).toBe("example");
    expect(compiled).toBe(afterRegistration);
  });

  it("describes each public gateway controller for catalog consumers", () => {
    expect(defineAtlas({ resources: [] }).defineHttpControllers().map(({ description }) => description)).toEqual([
      "Expose Atlas client manifest.",
      "Execute one operation exposed by Atlas manifest.",
      "Execute one Resource record Action through its configured exposure.",
    ]);
  });

  it("rejects operations outside the source catalog", () => {
    const source = defineCatalogAtlasSource({
      id: "application",
      actions: catalog,
    });
    const outsideQuery = defineAction({
      name: "outside.get",
      input: identifierSchema,
      output: modelSchema.nullable(),
      handler: () => null,
    });

    expect(() => source.query(outsideQuery)).toThrow(
      "outside its catalog",
    );
  });

  it("rejects duplicate resource identifiers", () => {
    const atlas = createAtlas();

    expect(() => defineAtlas({
      resources: [
        atlas.resources[0]!,
        atlas.resources[0]!,
      ],
    })).toThrow('Atlas resource id "example" is registered more than once.');
  });

  it("rejects duplicate operation exposure ids even when Resource ids are unique", () => {
    const resource = createAtlas().resources[0]!;
    const [first, ...otherExposures] = resource.getOperationExposures();
    // Custom Resources must share the same gateway allowlist as built-in Resources.
    const duplicate = { ...resource, getOperationExposures: () => [first!, ...otherExposures, first!] };
    expect(() => defineAtlas({ resources: [duplicate] })).toThrow(
      `Atlas operation exposure "${first!.id}" is registered more than once.`,
    );
  });

  it("rejects a collection exposure whose declared capability owner is absent", () => {
    const resource = createAtlas().resources[0]!;
    const exposures = resource.getOperationExposures();
    const listId = resource.toManifest().capabilities.list.id;
    const broken = {
      ...resource,
      getOperationExposures: () => exposures.map((exposure) => exposure.id === listId
        ? { ...exposure, collectionResourceId: "missing" }
        : exposure),
    };
    expect(() => defineAtlas({ resources: [broken] })).toThrow(
      `Atlas collection exposure "${listId}" references unknown Resource "missing".`,
    );
  });

  it("compiles source-independent relations and validates their targets", () => {
    const source = defineCatalogAtlasSource({
      id: "application",
      actions: catalog,
    });
    const createRelatedResource = (target: string) =>
      defineAtlasResource({
        id: "related",
        label: "Related models",
        source,
        identity: "id",
        displayField: "email",
        capabilities: {
          list: source.query(catalog.list),
          read: source.query(catalog.get),
          readMany: source.query(catalog.getMany),
          create: source.action(catalog.create),
          update: source.action(catalog.update),
          delete: source.action(catalog.delete),
        },
        fields: {
          email: { searchable: true },
          ownerId: {
            filterable: ["equals"],
            relation: {
              resource: target,
              cardinality: "one",
              lookup: {
                query: source.collectionQuery(catalog.list),
                pageSize: 12,
                minimumSearchLength: 2,
              },
            },
          },
        },
      });
    const resource = createRelatedResource("related");
    const compiledResource = defineAtlas({ resources: [resource] }).getManifest().resources[0]!;
    const relation = compiledResource.fields.find(
      (field) => field.id === "ownerId",
    );

    expect(compiledResource.displayField).toBe("email");
    expect(relation).toMatchObject({
      id: "ownerId",
      label: "Owner",
      kind: "relation",
      relation: {
        resource: "related",
        cardinality: "one",
        optional: false,
        lookup: {
          pageSize: 12,
          minimumSearchLength: 2,
          operation: {
            id: "resource:related:field:ownerId:lookup",
            effect: "read",
          },
        },
      },
    });
    expect(compiledResource.relatedCollections).toEqual([
      expect.objectContaining({
        id: "related.ownerId",
        label: "Related models",
        resource: "related",
        field: "ownerId",
        pageSize: 10,
        features: { search: true, filters: true, sorting: true, pagination: true, recordActions: true },
      }),
    ]);
    const manifest = resource.toManifest();
    const implicitInverse = {
      ...resource,
      // Custom Resource manifests may omit the default inverse cardinality.
      toManifest: () => ({ ...manifest, fields: manifest.fields.map((field) => {
        if (field.relation === undefined) return field;
        const { inverseCardinality: _inverseCardinality, ...relation } = field.relation;
        return { ...field, relation };
      }) }),
    };
    expect(defineAtlas({ resources: [implicitInverse] }).getManifest().resources[0]?.relatedCollections)
      .toStrictEqual(compiledResource.relatedCollections);
    expect(() => defineAtlas({
      resources: [createRelatedResource("missing")],
    }).getManifest()).toThrow('Atlas relation field "related.ownerId" references unknown Resource "missing".');
  });

  it("reports the Resource and Action owning an invalid relation parameter", () => {
    const resource = createAtlas().resources[0]!;
    const manifest = resource.toManifest();
    const broken = {
      ...resource,
      toManifest: () => ({
        ...manifest,
        recordActions: manifest.recordActions.map((action) => action.parameterFields === undefined ? action : {
          ...action,
          parameterFields: action.parameterFields.map((field) => field.relation === undefined ? field : {
            ...field, relation: { ...field.relation, resource: "missing" },
          }),
        }),
      }),
    };
    expect(() => defineAtlas({ resources: [broken] })).toThrow(
      'Atlas relation field "example.send-message.message" references unknown Resource "missing".',
    );
  });

  it("rejects a Resource display field missing from its read output", () => {
    const source = defineCatalogAtlasSource({
      id: "application",
      actions: catalog,
    });

    expect(() => defineAtlasResource({
      id: "invalid-display",
      label: "Invalid displays",
      source,
      identity: "id",
      displayField: "missing",
      capabilities: {
        list: source.query(catalog.list),
        read: source.query(catalog.get),
        readMany: source.query(catalog.getMany),
        create: source.action(catalog.create),
        update: source.action(catalog.update),
        delete: source.action(catalog.delete),
      },
    }).toManifest()).toThrow('display field "missing" does not exist');
  });

  it("omits disabled and inverse-one relations from record collections", () => {
    const source = defineCatalogAtlasSource({
      id: "application",
      actions: catalog,
    });
    const resource = defineAtlasResource({
      id: "example",
      label: "Examples",
      source,
      identity: "id",
      capabilities: {
        list: source.query(catalog.list),
        read: source.query(catalog.get),
        readMany: source.query(catalog.getMany),
        create: source.action(catalog.create),
        update: source.action(catalog.update),
        delete: source.action(catalog.delete),
      },
      fields: {
        profileId: {
          filterable: ["equals"],
          relation: {
            resource: "example",
            cardinality: "one",
            inverseCardinality: "one",
          },
        },
        hiddenOwnerId: {
          filterable: ["equals"],
          relation: {
            resource: "example",
            cardinality: "one",
            relatedRecords: false,
          },
        },
      },
    });

    expect(defineAtlas({ resources: [resource] })
      .getManifest().resources[0]?.relatedCollections).toEqual([]);
  });
});

it("omits unavailable mutations from read-only resource manifests and gateway exposures", () => {
  const source = defineCatalogAtlasSource({ id: "application", actions: catalog });
  const resource = defineAtlasResource({
    id: "inspection", label: "Inspection", source, identity: "id",
    capabilities: { list: source.query(catalog.list), read: source.query(catalog.get), readMany: source.query(catalog.getMany) },
    recordActions: { review: defineAtlasRecordAction({ label: "Review", recordInput: "id", action: source.action(catalog.fillName) }) },
  });
  const manifest = resource.toManifest();
  // Unavailable CRUD is absent, while explicit domain commands remain callable.
  expect(Object.keys(manifest.capabilities)).toEqual(["list", "read", "readMany"]);
  expect(manifest.fields.every((field) => field.readOnly)).toBe(true);
  expect(manifest.recordActions[0]?.id).toBe("review");
  expect(resource.getOperationExposures().map(({ id }) => id)).toEqual([
    "resource:inspection:list", "resource:inspection:read", "resource:inspection:read-many",
  ]);
});

it("compiles navigation labels and rejects blank group names", () => {
  const source = defineCatalogAtlasSource({ id: "application", actions: catalog });
  const options = {
    id: "inspection", label: "Inspection", source, identity: "id",
    capabilities: { list: source.query(catalog.list), read: source.query(catalog.get), readMany: source.query(catalog.getMany) },
  };
  expect(defineAtlasResource({ ...options, navigationGroup: "  Editorial  " }).toManifest().navigationGroup).toBe("Editorial");
  expect(defineAtlasResource(options).toManifest()).not.toHaveProperty("navigationGroup");
  expect(() => defineAtlasResource({ ...options, navigationGroup: "  " })).toThrow("navigation group label cannot be empty");
});
