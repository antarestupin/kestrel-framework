import { describe, expect, it } from "vitest";

import type {
  AtlasFieldManifest,
  AtlasOperationManifest,
  AtlasResourceManifest,
} from "../../contract.js";
import {
  createRelationLookupQuery,
  getRelationCandidate,
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

describe("atlas relation lookup", () => {
  it("builds only bounded first-page candidate requests", () => {
    expect(createRelationLookupQuery(field, "a")).toBeUndefined();
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
});
