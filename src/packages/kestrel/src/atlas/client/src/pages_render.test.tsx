import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  AtlasCollectionQuery,
  AtlasFieldManifest,
  AtlasManifest,
  AtlasOperationManifest,
  AtlasRecordActionManifest,
  AtlasResourceManifest,
} from "../../contract.js";
import {
  CollectionControls,
  OperationInput,
  RecordActionForm,
  ResourceCollection,
  ResourceForm,
  ResourceList,
  ResourceListView,
  ResourceRead,
} from "./pages.js";

const fieldDefaults = { hidden: false, readOnly: false, searchable: false, sortable: false, filterOperators: [] } as const;
const id: AtlasFieldManifest = { ...fieldDefaults, id: "id", label: "Identifier", kind: "id", schema: { type: "string" }, readOnly: true };
const name: AtlasFieldManifest = {
  ...fieldDefaults, id: "name", label: "Display name", kind: "text", schema: { type: "string" },
  searchable: true, sortable: true, filterOperators: ["contains", "is-null"],
};
const count: AtlasFieldManifest = {
  ...fieldDefaults, id: "count", label: "Score", kind: "number", schema: { type: ["integer", "null"] }, sortable: true,
};
const privateField: AtlasFieldManifest = { ...name, id: "private", label: "Private metadata", hidden: true };
const list: AtlasOperationManifest = { id: "resource:person:list", sourceId: "catalog", effect: "read", inputs: [] };
const read: AtlasOperationManifest = { ...list, id: "resource:person:read" };
const create: AtlasOperationManifest = {
  id: "resource:person:create", sourceId: "catalog", effect: "write", inputs: [
    { id: "id", required: true, schema: id.schema },
    { id: "name", required: true, schema: name.schema },
    { id: "count", required: false, schema: count.schema },
  ],
};
const update: AtlasOperationManifest = { ...create, id: "resource:person:update" };
const action: AtlasRecordActionManifest = {
  id: "notify", label: "Notify", recordInput: "id", presentation: "dialog",
  action: { ...create, inputs: [
    { id: "id", required: true, schema: id.schema },
    { id: "email", required: true, schema: { type: "string", format: "email" } },
  ] },
  parameterFields: [{ ...name, id: "email", label: "Recipient" }],
};
const resource: AtlasResourceManifest = {
  id: "person", label: "People", labelSingular: "Person", identity: "id", displayField: "name", sourceId: "catalog",
  fields: [id, name, count, privateField],
  capabilities: { list, read, readMany: read, create, update },
  views: [], recordActions: [action],
};
const manifest: AtlasManifest = {
  basePath: "/admin", title: "Coverage Atlas", icons: {}, resources: [resource],
  defaults: { textMaxLength: 15, recordActionsInList: "all" }, notifications: { position: "bottom-left" },
};
const collectionQuery: AtlasCollectionQuery = {
  pagination: { type: "page", page: 2, pageSize: 10 }, search: "Ada",
  filters: [{ field: "name", operator: "contains", value: "Ada" }, { field: "name", operator: "is-null" }],
  sorting: [{ field: "name", direction: "asc" }, { field: "count", direction: "desc" }],
};
const features = { search: true, filters: true, sorting: true, pagination: true, recordActions: true };
const noop = () => undefined;
const collectionCallbacks = { onRead: noop, onOpenRelation: noop, onOpenAction: noop, onQueryChange: noop, onEdit: noop };

function render(content: ReactNode, initialize?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  try {
    initialize?.(client);
    return renderToStaticMarkup(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
  } finally {
    client.clear();
  }
}

describe("Atlas Resource collection rendering", () => {
  it("renders search state, filters, ordered sort criteria and bounded page controls", () => {
    const markup = render(<ResourceList
      collectionQuery={collectionQuery} manifest={manifest} onCreate={noop} resource={resource} {...collectionCallbacks}
    />, (client) => client.setQueryData([resource.id, "collection", list.id, {}, collectionQuery], {
      items: [{ id: "1", name: "Ada Lovelace", count: 3, private: "private value" }, { name: "No identity" }], hasNextPage: true,
    }));
    expect(markup).toContain("Create person");
    expect(markup).toContain('value="Ada"');
    expect(markup).toContain("Clear");
    expect(markup).toContain('aria-label="Active filters"');
    expect(markup).toContain("Display name contains Ada");
    expect(markup).toContain("Display name is null");
    expect(markup).toContain(" ↑1");
    expect(markup).toContain(" ↓2");
    expect(markup).toContain("Ada Lovelace");
    expect(markup).toContain("No identity");
    expect(markup).toContain("Page 2");
    expect(markup).not.toContain("private value");
  });

  it("renders pending and empty collections while respecting embedded feature flags", () => {
    const readOnly = { ...resource, capabilities: { list, read, readMany: read }, recordActions: [] };
    const scoped = { filters: [{ field: "ownerId", operator: "equals" as const, value: "owner-1" }] };
    const props = {
      collectionQuery, manifest, resource: readOnly, scope: scoped,
      features: { ...features, search: false, sorting: false, pagination: false, recordActions: false }, controlsVisible: false,
      ...collectionCallbacks,
    };
    expect(render(<ResourceCollection {...props} />)).toContain("Loading…");
    const markup = render(<ResourceCollection {...props} />, (client) => client.setQueryData([
      resource.id, "collection", list.id, scoped, collectionQuery,
    ], { items: [], hasNextPage: false }));
    expect(markup).toContain("No records found.");
    expect(markup).not.toContain("collection-controls");
    expect(markup).not.toContain("column-sort");
    expect(markup).not.toContain("Page 2");
  });

  it("omits collection controls when unavailable and omits operands for null filters", () => {
    expect(render(<CollectionControls filtersEnabled={false} searchEnabled={false} onChange={noop} query={collectionQuery} resource={resource} />)).toBe("");
    const nullFilter = { ...name, filterOperators: ["is-null" as const] };
    const filterMarkup = render(<CollectionControls searchEnabled={false} onChange={noop} query={collectionQuery} resource={{ ...resource, fields: [nullFilter] }} />);
    expect(filterMarkup).toContain("Add filter");
    expect(filterMarkup).not.toContain('aria-label="Filter value"');
    expect(filterMarkup).not.toContain('type="search"');
  });

  it("shows View results and reports a failed list query through the visible error state", () => {
    const view = { id: "recent", label: "Recent people", renderer: "resource-list", query: list };
    const props = { manifest, resource, view, ...collectionCallbacks };
    const key = [resource.id, "view", view.id, 1, 20];
    const success = render(<ResourceListView {...props} />, (client) => client.setQueryData(key, {
      items: [{ id: "p1", name: "Recent member" }], hasNextPage: false,
    }));
    expect(success).toContain("Recent people");
    expect(success).toContain("Recent member");

    const failure = render(<ResourceListView {...props} />, (client) => {
      client.getQueryCache().build(client, { queryKey: key }).setState({ status: "error", error: new Error("Source unavailable") });
    });
    expect(failure).toContain('role="alert"');
    expect(failure).toContain("Source unavailable");
  });
});

describe("Atlas Resource forms and record details", () => {
  const formProps = { manifest, onCancel: noop, onSuccess: noop, resource };

  it("includes explicit identifiers in create forms and binds the update identifier to its route", () => {
    const createMarkup = render(<ResourceForm mode="create" {...formProps} />);
    expect(createMarkup).toContain("Create Person");
    expect(createMarkup).toMatch(/<input[^>]*name="id"/);
    expect(createMarkup).toMatch(/<input[^>]*type="number"[^>]*name="count"/);

    expect(render(<ResourceForm mode="update" recordId="1" {...formProps} />)).toContain("Loading…");
    const updateMarkup = render(<ResourceForm mode="update" recordId="1" {...formProps} />, (client) => client.setQueryData([
      resource.id, "read", "1",
    ], { data: { id: "1", name: "Ada", count: 7 }, effects: [] }));
    expect(updateMarkup).toContain("Edit record");
    expect(updateMarkup).toContain('value="Ada"');
    expect(updateMarkup).toContain('value="7"');
    expect(updateMarkup).not.toMatch(/<input[^>]*name="id"/);
  });

  it("shows the unavailable-operation state for read-only resources", () => {
    const readOnly = { ...resource, capabilities: { list, read, readMany: read } };
    const markup = render(<ResourceForm mode="create" {...formProps} resource={readOnly} />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("This operation is unavailable for this resource.");
  });

  it("renders record title, authorized links and visible fields for a loaded record", () => {
    const markup = render(<ResourceRead
      manifest={manifest} resource={resource} recordId="1" onDeleted={noop} onEdit={noop}
      onOpenAction={noop} onEditRelated={noop} onOpenRelatedAction={noop} onOpenRelation={noop}
    />, (client) => client.setQueryData([resource.id, "read", "1"], {
      data: { id: "1", name: "Ada Lovelace", count: 7, private: "private value" }, effects: [],
      recordLinks: [{ id: "public", label: "Public page", href: "/people/1" }],
    }));
    expect(markup).toContain("Ada Lovelace");
    expect(markup).toContain("Links");
    expect(markup).toContain("Edit");
    expect(markup).toContain('class="detail-panel"');
    expect(markup).toContain("Score");
    expect(markup).not.toContain("Private metadata");
  });

  it("renders scoped related collections with independent query results and a closed history panel", () => {
    const ownerFilter = { field: "ownerId", operator: "equals", value: "1" };
    const custom = { ...list, id: "resource:person:related-records" };
    const related = { id: "incoming", label: "Managed people", resource: resource.id, field: "ownerId", pageSize: 10, features };
    const join = { ...related, id: "joined", label: "Linked people", query: custom, recordInput: "parent" };
    const missing = { ...related, id: "removed", label: "Unknown resource", resource: "absent" };
    const viewed: AtlasResourceManifest = {
      ...resource, id: "owner", capabilities: { ...resource.capabilities, history: list },
      relatedCollections: [related, join, missing],
    };
    const firstPage = { pagination: { type: "page", page: 1, pageSize: 10 } };
    const markup = render(<ResourceRead
      manifest={{ ...manifest, resources: [resource, viewed] }} resource={viewed} recordId="1"
      onDeleted={noop} onEdit={noop} onOpenAction={noop} onEditRelated={noop} onOpenRelatedAction={noop} onOpenRelation={noop}
    />, (client) => {
      client.setQueryData([viewed.id, "read", "1"], { data: { id: "1", name: "Parent" }, effects: [] });
      client.setQueryData([resource.id, "collection", list.id, { filters: [ownerFilter] }, firstPage], {
        items: [{ id: "managed", name: "Managed child" }], hasNextPage: false,
      });
      client.setQueryData([resource.id, "collection", custom.id, { operation: custom, input: { parent: "1" } }, firstPage], {
        items: [{ id: "joined", name: "Linked child" }], hasNextPage: true,
      });
    });
    expect(markup).toContain("Managed people");
    expect(markup).toContain("Managed child");
    expect(markup).toContain("Linked people");
    expect(markup).toContain("Linked child");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("<summary>History</summary>");
    expect(markup).not.toContain("Unknown resource");
    expect(markup).not.toContain("Loading history");
  });

  it("uses explicit action parameter presentation and excludes the bound record input", () => {
    const markup = render(<RecordActionForm action={action} manifest={manifest} resource={resource} recordId="1" onSuccess={noop} onCancel={noop} />);
    expect(markup).toContain("Recipient");
    expect(markup).toContain('type="email"');
    expect(markup).not.toContain('name="id"');

    const noParameters = { ...action, action: { ...action.action, inputs: action.action.inputs.slice(0, 1) } };
    const direct = render(<RecordActionForm action={noParameters} manifest={manifest} resource={resource} recordId="1" onSuccess={noop} onCancel={noop} />);
    expect(direct).toContain("Run this Action for person 1.");
  });

  it.each([
    { id: "accepted", schema: { type: "boolean" }, control: 'type="checkbox"', value: true },
    { id: "birth", schema: { type: "string", format: "date" }, control: 'type="date"', value: "2026-01-10" },
    { id: "appointment", schema: { type: "string", format: "date-time" }, control: 'type="datetime-local"', value: "2026-01-10T12:00" },
    { id: "description", schema: { type: "string" }, control: "<textarea", value: "Details" },
    { id: "payload", schema: true, control: 'type="text"', value: null },
  ])("renders the inferred control for $id", ({ id, schema, control, value }) => {
    expect(render(<OperationInput definition={{ id, required: false, schema }} value={value} />)).toContain(control);
  });
});
