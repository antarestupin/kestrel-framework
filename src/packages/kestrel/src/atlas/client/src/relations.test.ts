import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  AtlasFieldManifest,
  AtlasManifest,
  AtlasOperationManifest,
  AtlasResourceManifest,
} from "../../contract.js";
import {
  createRelationHydrationRequests,
  resolveRelationReferences,
  resolveRelationValue,
} from "./relations.js";
import {
  FieldValue,
  getRecordActionParameterField,
} from "./pages.js";

const operation: AtlasOperationManifest = {
  id: "model.operation",
  sourceId: "application",
  effect: "read",
  inputs: [],
};

function createResource(
  id: string,
  fields: readonly AtlasFieldManifest[],
  displayField = "id",
): AtlasResourceManifest {
  return {
    id,
    label: `${id}s`,
    labelSingular: id,
    identity: "id",
    displayField,
    sourceId: "application",
    fields,
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
}

const idField: AtlasFieldManifest = {
  id: "id",
  label: "Id",
  kind: "id",
  schema: { type: "string" },
  hidden: false,
  readOnly: true,
  searchable: false,
  filterOperators: [],
  sortable: false,
};
const nameField: AtlasFieldManifest = {
  id: "name",
  label: "Name",
  kind: "text",
  schema: { type: "string" },
  hidden: false,
  readOnly: false,
  searchable: false,
  filterOperators: [],
  sortable: false,
};
const authorField: AtlasFieldManifest = {
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
  },
};
const reviewerField: AtlasFieldManifest = {
  ...authorField,
  id: "reviewerIds",
  label: "Reviewers",
  relation: {
    ...authorField.relation!,
    cardinality: "many",
  },
};
const userResource = createResource("user", [idField, nameField], "name");
const articleResource = createResource("article", [
  idField,
  authorField,
  reviewerField,
]);
const manifest: AtlasManifest = {
  basePath: "/atlas",
  title: "Atlas",
  defaults: { recordActionsInList: "all" },
  notifications: { position: "bottom-left" },
  icons: {},
  resources: [userResource, articleResource],
};

describe("atlas relation hydration", () => {
  it("inherits record Action parameter metadata and prefers explicit overrides", () => {
    const action = {
      id: "assign",
      label: "Assign",
      recordInput: "id",
      presentation: "dialog" as const,
      action: operation,
    };
    const override = { ...authorField, label: "Explicit author" };

    expect(getRecordActionParameterField(
      action,
      articleResource,
      "authorId",
    )).toBe(authorField);
    expect(getRecordActionParameterField(
      { ...action, parameterFields: [override] },
      articleResource,
      "authorId",
    )).toBe(override);
  });

  it("deduplicates relation identifiers into one request per target Resource", () => {
    const requests = createRelationHydrationRequests(
      manifest,
      articleResource,
      [
        { id: "article-1", authorId: "user-1", reviewerIds: ["user-1", "user-2"] },
        { id: "article-2", authorId: "user-2", reviewerIds: ["user-2", "user-3"] },
      ],
    );

    expect(requests).toEqual([{
      resource: userResource,
      ids: ["user-1", "user-2", "user-3"],
    }]);
  });

  it("resolves one and many relations through their display field", () => {
    const records = new Map([
      ["user", [
        { id: "user-1", name: "Ada" },
        { id: "user-2", name: "Grace" },
      ]],
    ]);

    expect(resolveRelationValue(authorField, "user-1", records, userResource))
      .toBe("Ada");
    expect(resolveRelationValue(
      reviewerField,
      ["user-2", "missing"],
      records,
      userResource,
    )).toEqual(["Grace", "missing"]);
    expect(resolveRelationReferences(
      manifest,
      authorField,
      "user-1",
      records,
    )).toEqual([{
      resourceId: "user",
      recordId: "user-1",
      label: "Ada",
    }]);
  });

  it("renders hydrated relation values as target record links", () => {
    const markup = renderToStaticMarkup(createElement(FieldValue, {
      basePath: "/atlas",
      field: authorField,
      relationReferences: [{
        resourceId: "user",
        recordId: "user-1",
        label: "Ada",
      }],
      value: "Ada",
    }));

    expect(markup).toContain('href="/atlas/user/user-1"');
    expect(markup).toContain(">Ada</a>");
  });
});
