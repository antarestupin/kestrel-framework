import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
  useRelationHydration,
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
  defaults: { textMaxLength: 50, recordActionsInList: "all" },
  notifications: { position: "bottom-left" },
  icons: {},
  resources: [userResource, articleResource],
};

describe("atlas relation hydration", () => {
  it("skips hidden relations and absent sparse values, and resolves indexed identities", () => {
    const requests = createRelationHydrationRequests(manifest, {
      ...articleResource, fields: [{ ...authorField, hidden: true }, reviewerField],
    }, [{ authorId: "hidden" }, { reviewerIds: ["user-1", "user-1"] }, {}]);
    expect(requests.map((request) => request.ids)).toEqual([["user-1"]]);
    const indexed = new Map([["user", new Map([['string:"user-1"', { id: "user-1", name: "Ada" }]])]]);
    expect(resolveRelationValue(authorField, "user-1", indexed, userResource)).toBe("Ada");
    expect(resolveRelationValue(authorField, "gone", indexed, userResource)).toBe("gone");
  });
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
      { ...action, parameterFields: [{ ...override, id: "unrelated", label: "Unrelated" }, override] },
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

  it("omits hydration requests for missing targets and records without visible identifiers", () => {
    expect(createRelationHydrationRequests(manifest, articleResource, [{ authorId: null, reviewerIds: [] }])).toEqual([]);
    expect(createRelationHydrationRequests({ ...manifest, resources: [articleResource] }, articleResource, [{ authorId: "user-1" }])).toEqual([]);
  });

  it("preserves empty and non-relation values without resolving record links", () => {
    const { relation: _relation, ...field } = authorField;
    const records = new Map([["user", [
      { id: "user-1", name: "Ada" }, { id: null, name: "Invalid null identity" }, { name: "Missing identity" },
    ]]]);
    for (const value of [undefined, null]) {
      expect(resolveRelationValue(authorField, value, records, userResource)).toBe(value);
      expect(resolveRelationReferences(manifest, authorField, value, records)).toEqual([]);
    }
    expect(resolveRelationValue(field, "user-1", records, userResource)).toBe("user-1");
    expect(resolveRelationReferences(manifest, field, "user-1", records)).toEqual([]);
  });

  it("expands arrays only for a to-many relation and preserves an older scalar value", () => {
    const records = new Map([["user", [{ id: "user-1", name: "Ada" }]]]);
    expect(resolveRelationValue(reviewerField, "user-1", records, userResource)).toBe("Ada");
    expect(resolveRelationReferences(manifest, reviewerField, "user-1", records)).toEqual([
      { resourceId: "user", recordId: "user-1", label: "Ada" },
    ]);
    const unexpectedArray = ["user-1"];
    expect(resolveRelationValue(authorField, unexpectedArray, records, userResource)).toBe(unexpectedArray);
    expect(resolveRelationReferences(manifest, authorField, unexpectedArray, records)).toEqual([
      { resourceId: "user", recordId: "user-1", label: unexpectedArray },
    ]);
  });

  it("reports a pending target while retaining labels from a cached target", () => {
    const company = createResource("company", [], "title");
    const companyField: AtlasFieldManifest = { ...authorField, id: "companyId", relation: {
      resource: company.id, cardinality: "one", optional: false,
    } };
    const source = { ...articleResource, fields: [authorField, companyField] };
    const activeManifest = { ...manifest, resources: [...manifest.resources, company] };
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData([company.id, "readMany", manifest.basePath, ["company-1"]], [{ id: "company-1", title: "Example Ltd" }]);

    function Status() {
      const state = useRelationHydration(activeManifest, source, [{ authorId: "user-1", companyId: "company-1" }]);
      return createElement("output", null, state.isPending ? "Pending" : "Ready", " / ", String(state.resolve(companyField, "company-1")));
    }

    try {
      expect(renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Status))))
        .toBe("<output>Pending / Example Ltd</output>");
    } finally {
      client.clear();
    }
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

  it("does not offer phantom record links for absent identifiers within a relation list", () => {
    const records = new Map([["user", [{ id: "user-1", name: "Ada" }, { id: "user-2" }]]]);
    expect(resolveRelationValue(reviewerField, ["user-1", "user-2"], records, userResource)).toEqual(["Ada", "user-2"]);
    expect(resolveRelationReferences(manifest, reviewerField, ["user-1", null, undefined, "user-2"], records)).toEqual([
      { resourceId: "user", recordId: "user-1", label: "Ada" },
      { resourceId: "user", recordId: "user-2", label: "user-2" },
    ]);
  });

  it("honors the relation display override for array-backed records without a target manifest", () => {
    const author = { ...authorField, relation: { ...authorField.relation!, displayField: "name" } };
    const records = new Map([["user", [{ id: "user-1", name: "Ada" }]]]);
    expect(resolveRelationValue(author, "user-1", records)).toBe("Ada");
    expect(resolveRelationValue(authorField, "user-1", records)).toBe("user-1");
    expect(resolveRelationReferences({ ...manifest, resources: [articleResource] }, author, "user-1", records)).toEqual([
      { resourceId: "user", recordId: "user-1", label: "Ada" },
    ]);
    expect(resolveRelationReferences({ ...manifest, resources: [articleResource] }, authorField, "user-1", records)).toEqual([
      { resourceId: "user", recordId: "user-1", label: "user-1" },
    ]);
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
