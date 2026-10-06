import { describe, expect, it } from "vitest";
import { z } from "zod";

import { uuidV7 } from "../utils/uuid.js";
import { defineAction } from "../actions/index.js";
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

function createAtlas() {
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
    defaults: { recordActionsInList: "none" },
    notifications: { position: "top-right" },
    resources: [resource],
  });
}

describe("Atlas", () => {
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
    expect(resource.capabilities.update.inputs).toEqual([
      expect.objectContaining({ id: "id" }),
      expect.objectContaining({ id: "email" }),
    ]);
    expect(resource.capabilities.readMany).toMatchObject({
      id: "resource:example:read-many",
      effect: "read",
      inputs: [expect.objectContaining({ id: "ids" })],
    });
    expect(resource.capabilities.delete.effect).toBe("destructive");
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
    })).toThrow("registered more than once");
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
    const compiledResource = defineAtlas({
      resources: [createRelatedResource("related")],
    }).getManifest().resources[0]!;
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
      }),
    ]);
    expect(() => defineAtlas({
      resources: [createRelatedResource("missing")],
    }).getManifest()).toThrow('references unknown Resource "missing"');
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
