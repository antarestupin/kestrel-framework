import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  AtlasFieldManifest,
  AtlasManifest,
  AtlasOperationManifest,
  AtlasResourceManifest,
} from "../../contract.js";
import {
  createRelationLookupQuery,
  getRelationCandidate,
  RelationInput,
} from "./relation_input.js";

const operation: AtlasOperationManifest = {
  id: "resource:user:list",
  sourceId: "application",
  effect: "read",
  inputs: [],
};
const target: AtlasResourceManifest = {
  id: "user",
  label: "Users",
  labelSingular: "User",
  identity: "id",
  displayField: "name",
  sourceId: "application",
  fields: [],
  capabilities: {
    list: operation,
    read: operation,
    readMany: operation,
    create: operation,
    update: operation,
    delete: operation,
  },
  views: [],
  recordActions: [],
};
const field: AtlasFieldManifest = {
  id: "authorId",
  label: "Author",
  kind: "relation",
  schema: { type: "string" },
  hidden: false,
  readOnly: false,
  searchable: false,
  filterOperators: [],
  sortable: false,
  relation: {
    resource: "user",
    cardinality: "one",
    optional: false,
    lookup: {
      pageSize: 15,
      minimumSearchLength: 2,
    },
  },
};
const manifest: AtlasManifest = {
  basePath: "/atlas", title: "Atlas", resources: [target], icons: {},
  defaults: { textMaxLength: 50, recordActionsInList: "all" },
  notifications: { position: "bottom-left" },
};

function renderPicker(
  currentField: AtlasFieldManifest,
  value?: unknown,
  resources = manifest.resources,
  initialize?: (client: QueryClient) => void,
) {
  const client = new QueryClient();
  try {
    initialize?.(client);
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RelationInput, {
      definition: { id: currentField.id, required: true, schema: currentField.schema },
      field: currentField, manifest: { ...manifest, resources }, value,
    })));
  } finally {
    client.clear();
  }
}

describe("atlas relation lookup", () => {
  it("builds only bounded first-page candidate requests", () => {
    expect(createRelationLookupQuery(field, "a")).toBeUndefined();
    expect(createRelationLookupQuery(field, " ab ")).toStrictEqual({
      pagination: { type: "page", page: 1, pageSize: 15 }, search: "ab",
    });
    expect(createRelationLookupQuery(field, "  Ada  ")).toEqual({
      pagination: { type: "page", page: 1, pageSize: 15 },
      search: "Ada",
    });
  });

  it("always submits the target Resource identity independently of its label", () => {
    expect(getRelationCandidate(target, field, {
      id: "user-1",
      name: "Ada Lovelace",
    })).toEqual({
      identity: "user-1",
      label: "Ada Lovelace",
    });
    expect(getRelationCandidate(target, field, { name: "Missing id" }))
      .toBeUndefined();
  });

  it("uses own record fields for relation identities and optional labels", () => {
    expect(getRelationCandidate({ ...target, identity: "constructor" }, field, { name: "Ada" }))
      .toBeUndefined();
    expect(getRelationCandidate({ ...target, displayField: "constructor" }, field, { id: "user-1" }))
      .toEqual({ identity: "user-1", label: "user-1" });
    expect(getRelationCandidate({ ...target, displayField: "constructor" }, field, { id: "user-1", constructor: "Ada" }))
      .toEqual({ identity: "user-1", label: "Ada" });
  });

  it("uses a bounded default browse request and the configured alternate label", () => {
    const browse = { ...field, relation: { resource: "user", cardinality: "one", optional: true, displayField: "nickname" } } as const;
    expect(createRelationLookupQuery(browse, " ")).toEqual({ pagination: { type: "page", page: 1, pageSize: 20 } });
    expect(getRelationCandidate(target, browse, { id: 0, name: "Name", nickname: "Nick" })).toEqual({ identity: 0, label: "Nick" });
    expect(getRelationCandidate(target, browse, { id: 0, nickname: null })).toEqual({ identity: 0, label: "0" });
    expect(getRelationCandidate(target, browse, { id: "user-1", nickname: "" })).toEqual({ identity: "user-1", label: "user-1" });
    expect(getRelationCandidate(target, browse, { id: null, nickname: "No identity" })).toBeUndefined();
  });

  it("falls back to the standard lookup and Resource label when relation metadata is absent", () => {
    const { relation: _relation, ...plain } = field;
    expect(createRelationLookupQuery(plain, " ")).toStrictEqual({ pagination: { type: "page", page: 1, pageSize: 20 } });
    expect(getRelationCandidate(target, plain, { id: "member", name: 0 })).toStrictEqual({ identity: "member", label: "0" });
    expect(getRelationCandidate(target, plain, { id: false, name: false })).toStrictEqual({ identity: false, label: "false" });
  });

  it.each([undefined, null, ""])("never emits a hidden identifier for an absent single selection (%s)", (value) => {
    expect(renderPicker(field, value)).not.toContain('type="hidden"');
  });

  it("keeps numeric and textual identifiers distinct while deduplicating equal identities", () => {
    const multiple: AtlasFieldManifest = {
      ...field, relation: { resource: "user", cardinality: "many", optional: true },
    };
    const markup = renderPicker(multiple, [0, "0", 0]);
    expect(markup.match(/type="hidden"/g)).toHaveLength(2);
  });

  it("shows the missing target error without emitting a form value", () => {
    const markup = renderPicker(field, "user-1", []);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The relation target is unavailable.");
    expect(markup).not.toContain('type="hidden"');
  });

  it("renders hydrated single selections while submitting only the identity", () => {
    const searchable: AtlasResourceManifest = { ...target, fields: [{ ...field, id: "name", searchable: true }] };
    const markup = renderPicker(field, "user-1", [searchable], (client) => client.setQueryData(
      [target.id, "relation-input", manifest.basePath, ["user-1"]], [{ id: "user-1", name: "Ada" }, { name: "Invalid row" }],
    ));
    expect(markup).toContain("Ada");
    expect(markup).toContain('aria-label="Remove user-1"');
    expect(markup).toContain('placeholder="Search users…"');
    expect(markup).toMatch(/<input[^>]*type="hidden"[^>]*name="authorId"[^>]*value="user-1"/);
    expect(markup).not.toContain("Invalid row");
  });

  it("deduplicates repeated identifiers and keeps missing labels visible", () => {
    const multiple: AtlasFieldManifest = {
      ...field, relation: { resource: "user", cardinality: "many", optional: true },
    };
    const markup = renderPicker(multiple, ["user-1", "user-1", "user-2"], [target], (client) => {
      client.setQueryData([target.id, "relation-input", manifest.basePath, ["user-1", "user-2"]], [{ id: "user-1", name: "Ada" }]);
      client.setQueryData([target.id, "relation-lookup", manifest.basePath, operation.id, { pagination: { type: "page", page: 1, pageSize: 20 } }], {
        items: [{ id: "user-1", name: "Ada" }, { id: null, name: "Invalid row" }],
      });
    });
    expect(markup.match(/type="hidden"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Remove user-2"');
    expect(markup).toContain('placeholder="Browse users…"');
    expect(markup).toContain("Enter identifiers directly");
    expect(renderPicker(multiple, "invalid-many-value")).not.toContain('type="hidden"');
  });
});
