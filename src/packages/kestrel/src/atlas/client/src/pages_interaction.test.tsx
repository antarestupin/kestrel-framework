// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, Outlet } from "@tanstack/react-router";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AtlasCollectionQuery,
  AtlasFieldManifest,
  AtlasManifest,
  AtlasOperationManifest,
  AtlasRecordActionManifest,
  AtlasResourceManifest,
} from "../../contract.js";
import { AtlasConfirmationProvider } from "./confirmation.js";
import { AtlasEffectProvider } from "./effects.js";
import { HistoryMatrix } from "./history_matrix.js";
import { RelationInput } from "./relation_input.js";
import {
  CollectionControls,
  RecordLinks,
  RecordActionForm,
  RecordActionPage,
  ResourceCreatePage,
  ResourceEditPage,
  ResourceForm,
  ResourceCollection,
  ResourceList,
  ResourceListPage,
  ResourceReadPage,
  ResourceListView,
  ResourcePagination,
  ResourceTable,
} from "./pages.js";
import { createAtlasRouter } from "./router.js";

const fieldDefaults = { hidden: false, readOnly: false, searchable: false, sortable: false, filterOperators: [] } as const;
const nameField = { ...fieldDefaults, id: "name", label: "Name", kind: "text", schema: { type: "string" }, searchable: true, filterOperators: ["contains", "is-null"] } satisfies AtlasFieldManifest;
const scoreField = { ...fieldDefaults, id: "score", label: "Score", kind: "number", schema: { type: "integer" }, filterOperators: ["in"] } satisfies AtlasFieldManifest;
const activeField = { ...fieldDefaults, id: "active", label: "Active", kind: "boolean", schema: { type: "boolean" } } satisfies AtlasFieldManifest;
const relationField = {
  ...fieldDefaults, id: "reviewerId", label: "Reviewer", kind: "relation",
  schema: { type: ["string", "null"] },
  relation: { resource: "person", cardinality: "one", optional: true },
} satisfies AtlasFieldManifest;

const operation = (id: string): AtlasOperationManifest => ({
  id, sourceId: "catalog", effect: "read", inputs: [],
});
const numericId = { id: "id", required: true, schema: { type: "integer" } } as const;
const person: AtlasResourceManifest = {
  id: "person", label: "People", labelSingular: "Person", identity: "id", displayField: "name", sourceId: "catalog",
  fields: [nameField],
  capabilities: {
    list: operation("person.list"), read: operation("person.read"), readMany: operation("person.read-many"),
  },
  views: [], recordActions: [],
};
const documentResource: AtlasResourceManifest = {
  id: "document", label: "Documents", labelSingular: "Document", identity: "id", displayField: "name", sourceId: "catalog",
  fields: [nameField, scoreField, relationField],
  capabilities: {
    list: operation("document.list"), read: operation("document.read"), readMany: operation("document.read-many"),
    history: operation("document.history"),
    update: {
      id: "document.update", sourceId: "catalog", effect: "write",
      inputs: [
        { id: "id", required: true, schema: { type: "string" } },
        { id: nameField.id, required: true, schema: nameField.schema },
        { id: relationField.id, required: false, schema: relationField.schema },
      ],
    },
  },
  views: [], recordActions: [],
};
const manifest: AtlasManifest = {
  basePath: "/admin", title: "Atlas", icons: {}, resources: [documentResource, person],
  defaults: { textMaxLength: 50, recordActionsInList: "all" },
  notifications: { position: "bottom-left" },
};
const notifyAction: AtlasRecordActionManifest = {
  id: "notify", label: "Notify", recordInput: "recordId", presentation: "dialog",
  feedback: { loading: "Sending notice", success: "Notice sent", error: "Notice failed" },
  action: {
    id: "document.notify", sourceId: "catalog", effect: "write",
    inputs: [
      { id: "recordId", required: true, schema: { type: "string" } },
      { id: "message", required: false, schema: { type: "string" } },
    ],
  },
};

function gateway(data: unknown): Response {
  return Response.json({ data, effects: [] });
}

function historyEvent(sequence: string, name: string) {
  return {
    sequence, changedAt: "2026-10-01T12:00:00Z", operation: "update",
    actor: null, reason: null, values: { name },
  };
}

describe("Atlas resource interactions", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { gcTime: Infinity } },
    });
  });

  afterEach(async () => {
    // Unmount subscribers before clearing their caches and restoring global stubs.
    try {
      await act(async () => root.unmount());
    } finally {
      client.clear();
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  async function render(content: ReactNode) {
    await act(async () => root.render(<QueryClientProvider client={client}>{content}</QueryClientProvider>));
  }

  async function renderRoute(resource: AtlasResourceManifest, path: string, relatedResource = person) {
    const activeManifest = { ...manifest, resources: [resource, relatedResource] };
    const { router, RouterProvider } = createAtlasRouter(activeManifest, {
      registries: { pages: {
        layout: Outlet, resourceCreate: ResourceCreatePage, resourceEdit: ResourceEditPage,
        resourceList: ResourceListPage, resourceRead: ResourceReadPage, recordAction: RecordActionPage,
      } },
    });
    router.update({ history: createMemoryHistory({ initialEntries: [`/admin${path}`] }) });
    await router.load();
    await render(<AtlasConfirmationProvider><AtlasEffectProvider manifest={activeManifest}>
      <RouterProvider router={router} />
    </AtlasEffectProvider></AtlasConfirmationProvider>);
    return router;
  }

  function element<Element extends HTMLElement>(selector: string): Element {
    const element = host.querySelector<Element>(selector);
    if (element === null) throw new Error(`Atlas test could not find ${selector}`);
    return element;
  }

  function button(label: string): HTMLButtonElement {
    const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
    if (button === undefined) throw new Error(`Atlas test could not find button "${label}"`);
    return button;
  }

  function portalControl(label: string, selector = "button"): HTMLElement {
    const control = [...document.body.querySelectorAll<HTMLElement>(selector)]
      .find((candidate) => candidate.textContent?.trim() === label);
    if (control === undefined) throw new Error(`Atlas test could not find control "${label}"`);
    return control;
  }

  async function chooseRecordAction(label: string) {
    await act(async () => button("Actions").click());
    await waitFor(() => expect(portalControl(label, '[role="menuitem"]')).toBeTruthy());
    await act(async () => portalControl(label, '[role="menuitem"]').click());
  }

  async function waitFor(assertion: () => void) {
    await vi.waitFor(async () => {
      // TanStack Query schedules subscriber notifications on a timer.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      assertion();
    });
  }

  function changeText(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    // Use the native setter so React sees a change from its tracked value.
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("keeps edited fields after a gateway rejection and invalidates Atlas data on retry", async () => {
    const firstSave = Promise.withResolvers<Response>();
    const onSuccess = vi.fn();
    const record = { id: "doc-1", name: "Original name", reviewerId: "old" };
    const submitted: unknown[] = [];
    fetch.mockImplementation(async (url, options) => {
      switch (String(url)) {
        case "/admin/api/operations/document.read": return gateway(record);
        case "/admin/api/operations/person.read-many":
          return gateway([{ id: "old", name: "Former reviewer" }, { id: "new", name: "New reviewer" }]);
        case "/admin/api/operations/document.update": {
          const { input } = JSON.parse(String(options?.body));
          submitted.push(input);
          return submitted.length === 1 ? firstSave.promise : gateway(input);
        }
        default: throw new Error(`Unexpected Atlas request: ${String(url)}`);
      }
    });
    // Inactive cache entries model data used after returning to another Atlas page.
    client.setQueryData(["person", "collection", "/admin"], ["cached label"]);
    client.setQueryData(["person", "collection", "/review"], ["other Atlas label"]);
    client.setQueryData(["outside-atlas", "collection", "/admin"], ["unrelated data"]);
    await render(<ResourceForm manifest={manifest} resource={documentResource} mode="update"
      recordId="doc-1" onCancel={vi.fn()} onSuccess={onSuccess} />);
    await waitFor(() => expect(element<HTMLInputElement>('input[name="name"]').value).toBe("Original name"));
    await act(async () => button("Enter identifiers directly").click());
    await act(async () => {
      changeText(element<HTMLInputElement>('input[name="name"]'), "Edited name");
      changeText(element<HTMLInputElement>('input[aria-label="Reviewer identifier"]'), "new");
    });
    await act(async () => button("Save").click());
    await waitFor(() => expect(button("Saving…").disabled).toBe(true));
    await act(async () => firstSave.resolve(Response.json({ error: "conflict" }, { status: 409 })));
    await waitFor(() => expect(element('[role="alert"]').textContent).toContain("409"));
    expect(element<HTMLInputElement>('input[name="name"]').value).toBe("Edited name");
    expect(element<HTMLInputElement>('input[aria-label="Reviewer identifier"]').value).toBe("new");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(client.getQueryState(["person", "collection", "/admin"])?.isInvalidated).toBe(false);

    await act(async () => button("Save").click());
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(submitted).toEqual(Array.from({ length: 2 }, () => ({
      id: "doc-1", name: "Edited name", reviewerId: "new",
    })));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(client.getQueryState(["person", "collection", "/admin"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["person", "collection", "/review"])?.isInvalidated).toBe(false);
    expect(client.getQueryState(["outside-atlas", "collection", "/admin"])?.isInvalidated).toBe(false);
  });

  it("keeps the editable record and typed values when a background refresh fails", async () => {
    fetch.mockResolvedValueOnce(gateway({ id: "doc-1", name: "Original name" }))
      .mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
    await render(<ResourceForm manifest={manifest} resource={documentResource} mode="update"
      recordId="doc-1" onCancel={vi.fn()} onSuccess={vi.fn()} />);
    await waitFor(() => expect(element<HTMLInputElement>('input[name="name"]').value).toBe("Original name"));
    await act(async () => changeText(element<HTMLInputElement>('input[name="name"]'), "Unsaved edit"));
    await act(async () => client.refetchQueries({ queryKey: ["document", "read", "/admin", "doc-1"] }));
    await waitFor(() => expect(element('[role="alert"]').textContent).toContain("503"));
    expect(element<HTMLInputElement>('input[name="name"]').value).toBe("Unsaved edit");
    expect(button("Save").disabled).toBe(false);
  });

  it("uses the declared create identity without treating an embedded record ID as an update target", async () => {
    const create = { ...operation("document.create"), effect: "write" as const,
      inputs: [{ id: "id", required: true, schema: { type: "string" } }],
    };
    const resource = { ...documentResource, capabilities: { ...documentResource.capabilities, create } };
    const onSuccess = vi.fn();
    fetch.mockImplementation(async () => gateway({ id: "created" }));
    await render(<ResourceForm manifest={manifest} resource={resource} mode="create"
      recordId="existing-route" onCancel={vi.fn()} onSuccess={onSuccess} />);
    await act(async () => changeText(element<HTMLInputElement>('input[name="id"]'), "created"));
    await act(async () => button("Save").click());
    await waitFor(() => expect(onSuccess).toHaveBeenCalledExactlyOnceWith({ id: "created" }));
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/admin/api/operations/document.create", expect.objectContaining({
      body: JSON.stringify({ input: { id: "created" } }),
    }));
  });

  it("loads a fresh record when an embedded form moves between Atlas mounts", async () => {
    fetch.mockImplementation(async (url) => gateway({
      id: "doc-1", name: String(url).startsWith("/admin/") ? "Admin record" : "Review record",
    }));
    for (const [basePath, name] of [["/admin", "Admin record"], ["/review", "Review record"]] as const) {
      await render(<ResourceForm key={basePath} manifest={{ ...manifest, basePath }}
        resource={documentResource} mode="update" recordId="doc-1" onCancel={vi.fn()} onSuccess={vi.fn()} />);
      await waitFor(() => expect(element<HTMLInputElement>('input[name="name"]').value).toBe(name));
    }
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/admin/api/operations/document.read", "/review/api/operations/document.read",
    ]);
  });

  it("submits false when a required boolean field is unchecked", async () => {
    const resource: AtlasResourceManifest = {
      ...documentResource,
      fields: [...documentResource.fields, activeField],
      capabilities: {
        ...documentResource.capabilities,
        update: {
          ...documentResource.capabilities.update!,
          inputs: [{ id: activeField.id, required: true, schema: activeField.schema }],
        },
      },
    };
    const onSuccess = vi.fn();
    fetch.mockImplementation(async () => gateway({ id: "doc-1", active: false }));
    client.setQueryData(["document", "read", "/admin", "doc-1"], { data: { id: "doc-1", active: true }, effects: [] });
    await render(<ResourceForm manifest={manifest} resource={resource} mode="update"
      recordId="doc-1" onCancel={vi.fn()} onSuccess={onSuccess} />);
    const checkbox = element<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox.checked).toBe(true);
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(false);
    expect(element<HTMLFormElement>("form").checkValidity()).toBe(true);
    await act(async () => button("Save").click());
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/admin/api/operations/document.update", expect.objectContaining({
      body: JSON.stringify({ input: { active: false, id: "doc-1" } }),
    }));
  });

  it("searches for a relation, submits its identity and explicitly clears it", async () => {
    const lookupInputs: unknown[] = [];
    const submissions: unknown[] = [];
    const record = { id: "doc-1", name: "Original name", reviewerId: "old" };
    fetch.mockImplementation(async (url, options) => {
      const { input } = JSON.parse(String(options?.body));
      switch (String(url)) {
        case "/admin/api/operations/document.read": return gateway(record);
        case "/admin/api/operations/person.list":
          lookupInputs.push(input);
          return gateway({ items: input.search === "new" ? [{ id: "new", name: "New reviewer" }] : [] });
        case "/admin/api/operations/person.read-many":
          return gateway(input.ids.map((id: string) => ({ id, name: id === "old" ? "Former reviewer" : "New reviewer" })));
        case "/admin/api/operations/document.update":
          submissions.push(input);
          return gateway(input);
        default: throw new Error(`Unexpected Atlas request: ${String(url)}`);
      }
    });
    const onSuccess = vi.fn();
    await render(<ResourceForm manifest={manifest} resource={documentResource} mode="update"
      recordId="doc-1" onCancel={vi.fn()} onSuccess={onSuccess} />);
    await waitFor(() => expect(host.textContent).toContain("Former reviewer"));
    const search = element<HTMLInputElement>('input[role="combobox"]');
    await act(async () => search.focus());
    await waitFor(() => expect(lookupInputs).toHaveLength(1));
    await act(async () => changeText(search, "new"));
    await waitFor(() => expect(document.body.querySelector('[role="option"]')?.textContent).toContain("New reviewer"));
    expect(lookupInputs[1]).toEqual({ pagination: { type: "page", page: 1, pageSize: 20 }, search: "new" });
    await act(async () => document.body.querySelector<HTMLElement>('[role="option"]')?.click());
    await waitFor(() => expect(element<HTMLInputElement>('input[name="reviewerId"]').value).toBe("new"));
    await act(async () => button("Save").click());
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(submissions).toEqual([{ id: "doc-1", name: "Original name", reviewerId: "new" }]);

    await act(async () => element<HTMLButtonElement>('button[aria-label="Remove new"]').click());
    await waitFor(() => expect(button("Save").disabled).toBe(false));
    await act(async () => button("Save").click());
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(2));
    expect(submissions[1]).toEqual({ id: "doc-1", name: "Original name", reviewerId: null });
  });

  it("cancels a destructive action before sending it and binds the record on confirmation", async () => {
    const action: AtlasRecordActionManifest = {
      id: "archive", label: "Archive", recordInput: "recordId", presentation: "dialog",
      confirmation: "Archive this document?",
      action: {
        id: "document.archive", sourceId: "catalog", effect: "destructive",
        inputs: [{ id: "recordId", required: true, schema: { type: "string" } }],
      },
    };
    const onSuccess = vi.fn();
    const archive = Promise.withResolvers<Response>();
    fetch.mockReturnValue(archive.promise);
    await render(<AtlasConfirmationProvider>
      <RecordActionForm action={action} manifest={manifest} resource={documentResource} recordId="doc-1"
        onCancel={vi.fn()} onSuccess={onSuccess} />
    </AtlasConfirmationProvider>);

    await act(async () => button("Archive").click());
    await waitFor(() => expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain("Archive this document?"));
    expect(document.body.querySelector('[role="alertdialog"] h2')?.textContent).toBe("Archive?");
    const confirmationButton = (label: string) => {
      const dialog = document.body.querySelector('[role="alertdialog"]');
      const control = [...dialog?.querySelectorAll("button") ?? []].find((candidate) => candidate.textContent?.trim() === label);
      if (control === undefined) throw new Error(`Atlas test could not find confirmation button "${label}"`);
      return control;
    };
    expect(confirmationButton("Archive").classList.contains("danger")).toBe(true);
    await act(async () => confirmationButton("Cancel").click());
    await waitFor(() => expect(document.body.querySelector('[role="alertdialog"]')).toBeNull());
    expect(fetch).not.toHaveBeenCalled();

    await act(async () => button("Archive").click());
    await act(async () => confirmationButton("Archive").click());
    await waitFor(() => expect(button("Running…").disabled).toBe(true));
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/admin/api/resources/document/record-actions/archive", expect.objectContaining({
      body: JSON.stringify({ input: { recordId: "doc-1" } }),
    }));
    await act(async () => archive.resolve(gateway({ archived: true })));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ data: { archived: true }, effects: [] }));
  });

  it("trims searches, resets pagination, and adds or removes typed filters", async () => {
    const onChange = vi.fn();
    const query: AtlasCollectionQuery = { search: "old", pagination: { type: "page", page: 5, pageSize: 10 } };
    const controls = (current: AtlasCollectionQuery) => (
      <CollectionControls onChange={onChange} query={current} resource={documentResource} />
    );
    await render(controls(query));
    expect([...element<HTMLSelectElement>('select[aria-label="Filter field"]').options].map(({ value }) => value))
      .toStrictEqual(["name", "score"]);
    expect(element<HTMLInputElement>('input[aria-label="Filter value"]').placeholder).toBe("Value");
    await act(async () => changeText(element<HTMLInputElement>('input[type="search"]'), "  new  "));
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    await act(async () => { element("form.collection-search").dispatchEvent(submit); });
    expect(submit.defaultPrevented).toBe(true);
    const firstPage = { ...query.pagination, page: 1 };
    expect(onChange).toHaveBeenLastCalledWith({ ...query, pagination: firstPage, search: "new" });
    await act(async () => button("Clear").click());
    expect(onChange).toHaveBeenLastCalledWith({ ...query, pagination: firstPage, search: undefined });
    expect(element<HTMLInputElement>('input[type="search"]').value).toBe("");

    await act(async () => {
      const field = element<HTMLSelectElement>('select[aria-label="Filter field"]');
      field.value = "score";
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(element<HTMLSelectElement>('select[aria-label="Filter operator"]').value).toBe("in");
    const filterValue = element<HTMLInputElement>('input[aria-label="Filter value"]');
    expect(filterValue.placeholder).toBe("Comma-separated values");
    await act(async () => changeText(filterValue, " 1, 2, , 3 "));
    await act(async () => button("Add filter").click());
    expect(filterValue.value).toBe("");
    const filter = { field: "score", operator: "in", value: [1, 2, 3] };
    expect(onChange).toHaveBeenLastCalledWith({ ...query, pagination: firstPage, filters: [filter] });
    await render(controls({ ...query, filters: [filter] } as AtlasCollectionQuery));
    expect(element('button[title="Remove filter"]').textContent?.trim()).toBe("Score in 1, 2, 3 ×");
    await act(async () => element<HTMLButtonElement>('button[title="Remove filter"]').click());
    expect(onChange).toHaveBeenLastCalledWith({ ...query, pagination: firstPage, filters: undefined });
  });

  it("keeps boolean-looking text as text and skips a blank scalar filter", async () => {
    const onChange = vi.fn();
    const query: AtlasCollectionQuery = { pagination: { type: "page", page: 2, pageSize: 10 } };
    await render(<CollectionControls onChange={onChange} query={query} resource={documentResource} />);
    const value = element<HTMLInputElement>('input[aria-label="Filter value"]');
    await act(async () => changeText(value, "   "));
    await act(async () => button("Add filter").click());
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => changeText(value, " true "));
    await act(async () => button("Add filter").click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      pagination: { ...query.pagination, page: 1 }, filters: [{ field: "name", operator: "contains", value: "true" }],
    });
  });

  it("loads history only on demand and retries the failed older page", async () => {
    const cursors: unknown[] = [];
    const latest = Promise.withResolvers<Response>();
    const older = Promise.withResolvers<Response>();
    fetch.mockImplementation(async (_url, options) => {
      const { input } = JSON.parse(String(options?.body));
      cursors.push(input.before);
      if (input.before === undefined) {
        return latest.promise;
      }
      if (cursors.length === 2) return older.promise;
      return gateway({ fields: ["name"], events: [historyEvent("1", "Earlier")], nextCursor: null });
    });
    await render(<HistoryMatrix manifest={manifest} resource={documentResource} recordId="doc-1" onOpenRelation={vi.fn()} />);
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      const details = element<HTMLDetailsElement>("details");
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(host.textContent).toContain("Loading history");
    expect(host.textContent).not.toContain("No history recorded.");
    const viewport = element<HTMLDivElement>(".history-viewport");
    let scrollWidth = 120;
    Object.defineProperty(viewport, "scrollWidth", { get: () => scrollWidth });
    await act(async () => latest.resolve(gateway({ fields: ["name"], events: [historyEvent("2", "Latest")], nextCursor: "2" })));
    await waitFor(() => expect(host.textContent).toContain("Latest"));
    expect(host.textContent).not.toContain("No history recorded.");
    expect(viewport.scrollLeft).toBe(120);
    viewport.scrollLeft = 80;
    await act(async () => button("Load older changes").click());
    await waitFor(() => expect(button("Load older changes").disabled).toBe(true));
    await act(async () => older.resolve(Response.json({ error: "temporarily unavailable" }, { status: 503 })));
    await waitFor(() => expect(element('[role="alert"]').textContent).toContain("could not be loaded"));
    expect(host.textContent).toContain("Latest");
    scrollWidth = 200;
    await act(async () => button("Retry").click());
    await waitFor(() => expect(cursors).toHaveLength(3));
    expect(cursors).toEqual([undefined, "2", "2"]);
    await waitFor(() => expect(host.textContent).toContain("Earlier"));
    expect(host.textContent?.indexOf("Earlier")).toBeLessThan(host.textContent?.indexOf("Latest") ?? 0);
    expect(viewport.scrollLeft).toBe(160);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps history caches separate for embedded Atlas mounts sharing a QueryClient", async () => {
    const requested: string[] = [];
    fetch.mockImplementation(async (url) => {
      requested.push(String(url));
      const label = String(url).startsWith("/admin/") ? "Administration event" : "Review event";
      return gateway({ fields: ["name"], events: [historyEvent("1", label)], nextCursor: null });
    });
    for (const [basePath, label] of [["/admin", "Administration event"], ["/review", "Review event"]] as const) {
      await render(<HistoryMatrix key={basePath} manifest={{ ...manifest, basePath }} resource={documentResource} recordId="doc-1" onOpenRelation={vi.fn()} />);
      await act(async () => {
        const details = element<HTMLDetailsElement>("details");
        details.open = true;
        details.dispatchEvent(new Event("toggle"));
      });
      await waitFor(() => expect(host.textContent).toContain(label));
    }
    expect(requested).toEqual(["/admin/api/operations/document.history", "/review/api/operations/document.history"]);
    expect(host.textContent).not.toContain("Administration event");
  });

  it("retries an initial history failure and reports an empty result", async () => {
    fetch.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(gateway({ fields: ["name"], events: [], nextCursor: null }));
    await render(<HistoryMatrix manifest={manifest} resource={documentResource} recordId="doc-1" onOpenRelation={vi.fn()} />);
    await act(async () => {
      const details = element<HTMLDetailsElement>("details");
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    await waitFor(() => expect(element('[role="alert"]').textContent).toContain("could not be loaded"));
    await act(async () => button("Retry").click());
    await waitFor(() => expect(host.textContent).toContain("No history recorded."));
    const requests = fetch.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
    expect(requests).toEqual(Array.from({ length: 2 }, () => ({ input: { id: "doc-1", pageSize: 20 } })));
  });

  it("resets the edit draft when the route switches to a different cached record", async () => {
    const first = { data: { id: "first", name: "First document" }, effects: [] };
    const second = { data: { id: "second", name: "Second document" }, effects: [] };
    client.setQueryData(["document", "read", "/admin", "first"], first);
    client.setQueryData(["document", "read", "/admin", "second"], second);
    const router = await renderRoute(documentResource, "/document/first/edit");
    await waitFor(() => expect(element<HTMLInputElement>('input[name="name"]').value).toBe("First document"));
    await act(async () => changeText(element<HTMLInputElement>('input[name="name"]'), "Unsaved first document"));

    await act(async () => router.navigate({ to: "/document/second/edit" }));
    await waitFor(() => expect(element<HTMLInputElement>('input[name="name"]').value).toBe("Second document"));
  });

  it("keeps non-addressable rows visible without inventing record actions", async () => {
    const onRead = vi.fn();
    await render(<ResourceTable manifest={manifest} resource={documentResource} fields={[nameField]}
      items={[{ name: "Projection without identity" }, { id: 0, name: "Real record zero" }]}
      onEdit={vi.fn()} onOpenAction={vi.fn()} onOpenRelation={vi.fn()} onRead={onRead} />);
    const [projection, addressable] = host.querySelectorAll("tbody tr");
    expect(projection?.textContent).toContain("Projection without identity");
    expect(projection?.querySelector("button")).toBeNull();
    await act(async () => addressable?.querySelector<HTMLButtonElement>("button")?.click());
    expect(onRead).toHaveBeenCalledExactlyOnceWith("0");
  });

  it("uses the declared numeric identity when opening and updating a record from the collection", async () => {
    const update = documentResource.capabilities.update!;
    const resource = { ...documentResource, capabilities: {
      ...documentResource.capabilities,
      read: { ...operation("document.read"), inputs: [numericId] },
      update: { ...update, inputs: [numericId, ...update.inputs.slice(1)] },
    } };
    let name = "Opened document zero";
    fetch.mockImplementation(async (url, options) => {
      if (String(url).endsWith("document.list")) return gateway({ items: [{ id: 0, name: "Numeric document" }] });
      const { input } = JSON.parse(String(options?.body));
      if (input.id !== 0) return new Response(null, { status: 400 });
      if (String(url).endsWith("document.update")) name = input.name;
      return gateway({ id: 0, name });
    });
    const router = await renderRoute(resource, "/document");
    await waitFor(() => expect(host.textContent).toContain("Numeric document"));
    await act(async () => button("View").click());
    await waitFor(() => expect(router.history.location.pathname).toBe("/admin/document/0"));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/admin/api/operations/document.read", expect.objectContaining({
      body: JSON.stringify({ input: { id: 0 } }),
    })));
    await waitFor(() => expect(host.textContent).toContain("Opened document zero"));
    await act(async () => button("Edit").click());
    await waitFor(() => expect(element<HTMLInputElement>('input[name="name"]').value).toBe("Opened document zero"));
    await act(async () => changeText(element<HTMLInputElement>('input[name="name"]'), "Renamed document zero"));
    await act(async () => button("Save").click());
    await waitFor(() => expect(host.textContent).toContain("Renamed document zero"));
    expect(fetch).toHaveBeenCalledWith("/admin/api/operations/document.update", expect.objectContaining({
      body: JSON.stringify({ input: { name: "Renamed document zero", id: 0 } }),
    }));
  });

  it("treats prototype-named identities as addressable only when the record defines one", async () => {
    const onRead = vi.fn();
    const resource = { ...documentResource, identity: "constructor" };
    await render(<ResourceTable manifest={manifest} resource={resource} fields={[nameField, { ...nameField, id: "constructor" }]}
      items={[{ name: "Projection" }, { constructor: "actual", name: "Addressable" }]}
      onEdit={vi.fn()} onOpenAction={vi.fn()} onOpenRelation={vi.fn()} onRead={onRead} />);
    const [projection, addressable] = host.querySelectorAll("tbody tr");
    expect(projection?.querySelector("button")).toBeNull();
    expect(projection?.querySelector(".empty-value")?.textContent).toBe("—");
    expect(addressable?.querySelectorAll("td")[1]?.textContent).toBe("actual");
    await act(async () => addressable?.querySelector<HTMLButtonElement>("button")?.click());
    expect(onRead).toHaveBeenCalledExactlyOnceWith("actual");
  });

  it("renders missing prototype-named detail fields as empty values", async () => {
    const field = { ...nameField, id: "constructor", label: "Constructor" };
    fetch.mockImplementation(async () => gateway({ id: "doc-1", name: "Document one" }));
    await renderRoute({ ...documentResource, fields: [field] }, "/document/doc-1");
    await waitFor(() => expect(element(".detail-panel dt").textContent).toBe("Constructor"));
    expect(element(".detail-panel dd").textContent).toBe("—");
  });

  it("groups allowed row Actions separately from edit and binds callbacks to the selected record", async () => {
    const pageAction = { ...notifyAction, presentation: "page" as const };
    const hidden = { ...pageAction, id: "internal", label: "Hidden action", showInList: false };
    const resource = { ...documentResource, recordActions: [pageAction, hidden] };
    const onEdit = vi.fn();
    const onOpenAction = vi.fn();
    const table = (enabled?: boolean) => <ResourceTable
      manifest={manifest} resource={resource} fields={[nameField]}
      items={[{ id: "doc-2", name: "Second document" }]}
      onEdit={onEdit} onOpenAction={onOpenAction} onOpenRelation={vi.fn()} onRead={vi.fn()}
      {...(enabled === undefined ? {} : { recordActionsEnabled: enabled })} />;
    await render(table(false));
    expect(host.textContent).toContain("View");
    expect(host.textContent).not.toContain("ActionsNotify");
    expect(host.querySelector(".action-menu")).toBeNull();
    await render(table());

    await chooseRecordAction("Notify");
    expect(onOpenAction).toHaveBeenCalledExactlyOnceWith("doc-2", pageAction);
    await act(async () => button("Actions").click());
    const menu = document.body.querySelector('[role="menu"]')!;
    expect(menu.querySelector('[role="separator"]')).not.toBeNull();
    expect(menu.textContent).not.toContain("Hidden action");
    expect(menu.textContent).not.toContain("Delete");
    await act(async () => portalControl("Edit", '[role="menuitem"]').click());
    expect(onEdit).toHaveBeenCalledExactlyOnceWith("doc-2");
  });

  it("keeps an open row Action bound to its record when the collection reorders", async () => {
    const resource = { ...documentResource, recordActions: [notifyAction] };
    const first = { id: "first", name: "First document" };
    const second = { id: "second", name: "Second document" };
    let items = [first, second];
    const submitted = vi.fn();
    fetch.mockImplementation(async (url, options) => {
      if (String(url).endsWith("document.list")) return gateway({ items });
      submitted(JSON.parse(String(options?.body)));
      return gateway(null);
    });
    await renderRoute(resource, "/document");
    await waitFor(() => expect(host.querySelectorAll("tbody tr")).toHaveLength(2));
    const firstRow = host.querySelectorAll("tbody tr")[0]!;
    await act(async () => [...firstRow.querySelectorAll("button")].find(({ textContent }) => textContent?.trim() === "Actions")!.click());
    await act(async () => portalControl("Notify", '[role="menuitem"]').click());
    await waitFor(() => expect(document.querySelector('.dialog-panel[role="dialog"] a')?.getAttribute("href")).toContain("/first/actions/notify"));

    items = [second, first];
    await act(async () => client.refetchQueries({ queryKey: ["document", "collection"] }));
    await waitFor(() => expect(host.querySelector("tbody tr")?.textContent).toContain("Second document"));
    expect(document.querySelector('.dialog-panel[role="dialog"] a')?.getAttribute("href")).toContain("/first/actions/notify");
    await act(async () => portalControl("Notify", '.dialog-panel[role="dialog"] button').click());
    await waitFor(() => expect(submitted).toHaveBeenCalledExactlyOnceWith({ input: { recordId: "first" } }));
  });

  it("shows no empty menu and omits standard controls for an Action-only row", async () => {
    const readOnly: AtlasResourceManifest = {
      ...documentResource, capabilities: person.capabilities,
    };
    const table = (resource: AtlasResourceManifest) => <ResourceTable manifest={manifest} resource={resource} fields={[nameField]}
      items={[{ id: "first", name: "First document" }]} onEdit={vi.fn()} onOpenAction={vi.fn()}
      onOpenRelation={vi.fn()} onRead={vi.fn()} />;
    await render(table(readOnly));
    expect(host.querySelector(".action-menu")).toBeNull();
    expect(host.querySelector(".empty-state")).toBeNull();
    await render(table({ ...readOnly, recordActions: [notifyAction] }));
    await act(async () => button("Actions").click());
    const menu = document.body.querySelector('[role="menu"]')!;
    expect([...menu.querySelectorAll('[role="menuitem"]')].map(({ textContent }) => textContent?.trim())).toEqual(["Notify"]);
    expect(menu.querySelector('[role="separator"]')).toBeNull();
  });

  it("goes back one collection page while keeping the first page boundary disabled", async () => {
    const onPageChange = vi.fn();
    await render(<ResourcePagination hasNextPage={false} onPageChange={onPageChange} page={3} />);
    expect(button("Next").disabled).toBe(true);
    await act(async () => button("Previous").click());
    expect(onPageChange).toHaveBeenCalledExactlyOnceWith(2);
    await render(<ResourcePagination hasNextPage onPageChange={onPageChange} page={1} />);
    expect(button("Previous").disabled).toBe(true);
  });

  it("opens authorized record links as native anchors in the links menu", async () => {
    await render(<RecordLinks links={[
      { id: "public", label: "Public document", href: "/documents/0" },
      { id: "help", label: "Help", href: "https://example.test/documents" },
    ]} />);
    await act(async () => button("Links").click());
    const links = document.querySelectorAll<HTMLAnchorElement>(".record-links-menu a");
    expect([...links].map((link) => [link.textContent?.trim(), link.getAttribute("href"), link.target, link.rel])).toEqual([
      ["Public document", "/documents/0", "_blank", "noopener noreferrer"],
      ["Help", "https://example.test/documents", "_blank", "noopener noreferrer"],
    ]);
  });

  it("releases the table's scroll and resize listeners on unmount", async () => {
    const observe = vi.fn<(target: Element) => void>();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      observe = observe;
      disconnect = disconnect;
    });
    await render(<ResourceTable manifest={manifest} resource={documentResource}
      fields={[nameField]} items={[]} onEdit={vi.fn()} onOpenAction={vi.fn()}
      onOpenRelation={vi.fn()} onRead={vi.fn()} />);
    const panel = element(".table-panel");
    expect(observe.mock.calls.map(([target]) => target)).toEqual([panel, element("table")]);
    const remove = vi.spyOn(panel, "removeEventListener");
    try {
      await render(null);
      expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
      expect(disconnect).toHaveBeenCalledOnce();
    } finally { remove.mockRestore(); }
  });

  it("renders the table and updates its scroll indicator without ResizeObserver", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    await render(<ResourceTable manifest={manifest} resource={documentResource}
      fields={[nameField]} items={[{ id: "one", name: "First document" }]} onEdit={vi.fn()} onOpenAction={vi.fn()}
      onOpenRelation={vi.fn()} onRead={vi.fn()} />);
    expect(host.querySelector("tbody")?.textContent).toContain("First document");
    const panel = element(".table-panel");
    Object.defineProperties(panel, { clientWidth: { value: 100 }, scrollWidth: { value: 150 } });
    await act(async () => panel.dispatchEvent(new Event("scroll")));
    expect(panel.classList.contains("show-action-shadow")).toBe(true);
  });

  it("keeps action inputs after refusal and follows the returned success target after retry", async () => {
    const action = { ...notifyAction, action: { ...notifyAction.action, inputs: [
      { ...numericId, id: "recordId" }, notifyAction.action.inputs[1]!,
    ] } };
    const resource = { ...documentResource, recordActions: [action] };
    const body: unknown[] = [];
    const retry = Promise.withResolvers<Response>();
    fetch.mockImplementation(async (url, options) => {
      if (String(url).endsWith("/record-actions/notify")) {
        body.push(JSON.parse(String(options?.body)));
        return body.length === 1
          ? Response.json({ error: "Gateway rejected the notice" }, { status: 403 })
          : retry.promise;
      }
      return gateway({ id: "target", name: "Returned target" });
    });
    const router = await renderRoute(resource, "/document/0/actions/notify");
    await waitFor(() => expect(element('input[name="message"]')).toBeTruthy());
    await act(async () => changeText(element<HTMLInputElement>('input[name="message"]'), "Review is ready"));
    await act(async () => button("Notify").click());
    await waitFor(() => expect(element('[role="alert"]').textContent).toContain("403"));
    expect(document.body.textContent).toContain("Notice failed");
    expect(element<HTMLInputElement>('input[name="message"]').value).toBe("Review is ready");

    await act(async () => button("Notify").click());
    await waitFor(() => expect(button("Running…").disabled).toBe(true));
    expect(document.body.textContent).toContain("Sending notice");
    await act(async () => retry.resolve(Response.json({
      data: {},
      effects: [
        { type: "notification", level: "success", message: "Notice delivered" },
        { type: "redirect", target: { resource: "person", recordId: "target" } },
      ],
    })));
    await waitFor(() => expect(router.history.location.pathname).toBe("/admin/person/target"));
    expect(document.body.textContent).toContain("Notice delivered");
    expect(body).toEqual(Array.from({ length: 2 }, () => ({ input: { recordId: 0, message: "Review is ready" } })));
  });

  it.each(["detail", "list"])("requires confirmation and retries failed deletion from the %s", async (surface) => {
    const resource = {
      ...documentResource,
      capabilities: { ...documentResource.capabilities, delete: {
        ...operation("document.delete"), effect: "destructive" as const, inputs: [numericId],
      } },
    };
    const deletion = Promise.withResolvers<Response>();
    const submitted: unknown[] = [];
    fetch.mockImplementation(async (url, options) => {
      if (String(url).endsWith("document.delete")) {
        submitted.push(JSON.parse(String(options?.body)));
        return submitted.length === 1
          ? Response.json({ error: "Delete unavailable" }, { status: 503 })
          : deletion.promise;
      }
      return gateway(String(url).endsWith("document.list")
        ? { items: submitted.length > 1 ? [] : [{ id: 0, name: "Document one" }], hasNextPage: false }
        : { id: 0, name: "Document one" });
    });
    const router = await renderRoute(resource, surface === "detail" ? "/document/0" : "/document");
    await waitFor(() => expect(host.textContent).toContain("Document one"));
    await chooseRecordAction("Delete");
    expect(document.body.querySelector('[role="alertdialog"] h2')?.textContent).toBe("Delete document?");
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain("Delete this document? This cannot be undone.");
    expect(portalControl("Delete", '[role="alertdialog"] button').classList.contains("danger")).toBe(true);
    await act(async () => portalControl("Cancel", '[role="alertdialog"] button').click());
    expect(submitted).toEqual([]);
    await chooseRecordAction("Delete");
    await act(async () => portalControl("Delete", '[role="alertdialog"] button').click());
    await waitFor(() => expect(element('[role="alert"]').textContent).toContain("503"));
    await chooseRecordAction("Delete");
    await act(async () => portalControl("Delete", '[role="alertdialog"] button').click());
    await waitFor(() => expect(submitted).toHaveLength(2));
    await chooseRecordAction("Deleting…");
    expect(portalControl("Deleting…", '[role="menuitem"]').getAttribute("aria-disabled")).toBe("true");
    await act(async () => deletion.resolve(gateway({})));
    await waitFor(() => expect(host.textContent).toContain("No records found."));
    expect(router.history.location.pathname).toBe("/admin/document");
    expect(submitted).toEqual([{ input: { id: 0 } }, { input: { id: 0 } }]);
  });

  it("asks before discarding a populated action dialog, then follows its success redirect", async () => {
    const resource = { ...documentResource, recordActions: [notifyAction] };
    const submitted: unknown[] = [];
    fetch.mockImplementation(async (url, options) => {
      if (String(url).endsWith("/record-actions/notify")) {
        submitted.push(JSON.parse(String(options?.body)));
        return Response.json({ data: {}, effects: submitted.length === 1 ? [
          { type: "redirect", target: { resource: "person", recordId: "linked" } },
        ] : [] });
      }
      return gateway({ id: "doc-1", name: "Document one" });
    });
    const router = await renderRoute(resource, "/document/doc-1");
    await waitFor(() => expect(host.textContent).toContain("Document one"));
    await chooseRecordAction("Notify");
    expect(document.body.querySelector('.dialog-panel[role="dialog"] a')?.getAttribute("href")).toBe("/admin/document/doc-1/actions/notify");
    await act(async () => portalControl("Close dialog", '.dialog-panel[role="dialog"] button').click());
    await waitFor(() => expect(document.body.querySelector('.dialog-panel[role="dialog"]')).toBeNull());

    await chooseRecordAction("Notify");
    const messageInput = document.body.querySelector<HTMLInputElement>('.dialog-panel[role="dialog"] input[name="message"]')!;
    await act(async () => changeText(messageInput, "Keep this text"));
    await act(async () => portalControl("Cancel", '.dialog-panel[role="dialog"] button').click());
    await waitFor(() => expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain("Discard the entered values?"));
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain("The values entered in this form will be lost.");
    expect(portalControl("Discard", '[role="alertdialog"] button').classList.contains("danger")).toBe(true);
    await act(async () => portalControl("Cancel", '[role="alertdialog"] button').click());
    expect(messageInput.value).toBe("Keep this text");

    await act(async () => portalControl("Cancel", '.dialog-panel[role="dialog"] button').click());
    await act(async () => portalControl("Discard", '[role="alertdialog"] button').click());
    await waitFor(() => expect(document.body.querySelector('.dialog-panel[role="dialog"]')).toBeNull());
    expect(submitted).toEqual([]);

    await chooseRecordAction("Notify");
    await act(async () => portalControl("Notify", '.dialog-panel[role="dialog"] button').click());
    await waitFor(() => expect(router.history.location.pathname).toBe("/admin/person/linked"));
    await act(async () => router.navigate({ to: "/document/doc-1" }));
    await waitFor(() => expect(host.textContent).toContain("Document one"));
    await chooseRecordAction("Notify");
    await act(async () => portalControl("Notify", '.dialog-panel[role="dialog"] button').click());
    await waitFor(() => expect(document.body.querySelector('.dialog-panel.dialog-panel[role="dialog"]')).toBeNull());
    expect(router.history.location.pathname).toBe("/admin/document/doc-1");
    expect(submitted).toEqual(Array.from({ length: 2 }, () => ({ input: { recordId: "doc-1" } })));
  });

  it("navigates from a create form to a returned record or back to the collection", async () => {
    const resource = { ...documentResource, capabilities: {
      ...documentResource.capabilities,
      create: { ...operation("document.create"), effect: "write" as const, inputs: [
        { id: "name", required: true, schema: { type: "string" } },
        { id: "note", required: false, schema: { type: "string" } },
      ] },
    } };
    const submitted: unknown[] = [];
    fetch.mockImplementation(async (url, options) => {
      if (String(url).endsWith("document.create")) {
        submitted.push(JSON.parse(String(options?.body)));
        return gateway([{ id: "new-id" }, { id: 0 }, {}, null][submitted.length - 1]);
      }
      return gateway(String(url).endsWith("document.list")
        ? { items: [], hasNextPage: false } : { id: "new-id", name: "New document" });
    });
    const router = await renderRoute(resource, "/document/create");
    for (const [title, destination] of [["First", "/admin/document/new-id"], ["Second", "/admin/document/0"], ["Third", "/admin/document"], ["Fourth", "/admin/document"]]) {
      await act(async () => router.navigate({ to: "/document/create" }));
      await waitFor(() => expect(element('input[name="name"]')).toBeTruthy());
      await act(async () => changeText(element<HTMLInputElement>('input[name="name"]'), title!));
      await act(async () => button("Save").click());
      await waitFor(() => expect(router.history.location.pathname).toBe(destination));
    }
    expect(submitted).toEqual(["First", "Second", "Third", "Fourth"].map((name) => ({ input: { name } })));
  });

  it("cancels create, edit and record Action forms without submitting their operations", async () => {
    const resource = {
      ...documentResource,
      capabilities: {
        ...documentResource.capabilities,
        create: { ...operation("document.create"), effect: "write" as const },
      },
      recordActions: [notifyAction],
    };
    fetch.mockImplementation(async (url) => gateway(String(url).endsWith("document.list")
      ? { items: [] } : { id: "doc-1", name: "Document one" }));
    const router = await renderRoute(resource, "/document/create");
    await act(async () => button("Cancel").click());
    await waitFor(() => expect(router.history.location.pathname).toBe("/admin/document"));
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("document.read"))).toBe(false);

    for (const suffix of ["edit", "actions/notify"]) {
      await act(async () => router.navigate({ to: `/document/doc-1/${suffix}` }));
      await waitFor(() => expect(button("Cancel")).toBeDefined());
      await act(async () => button("Cancel").click());
      await waitFor(() => expect(router.history.location.pathname).toBe("/admin/document/doc-1"));
    }
    expect(fetch.mock.calls.map(([url]) => String(url))).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/document\.create|document\.update|record-actions/),
    ]));
  });

  it.each(["edit", "actions/notify"] as const)("runs one write when the %s form is submitted twice before rendering pending state", async (suffix) => {
    const resource = { ...documentResource, recordActions: [notifyAction] };
    const accepted = Promise.withResolvers<Response>();
    const written = vi.fn();
    fetch.mockImplementation(async (url) => {
      if (/document\.update|record-actions\/notify/.test(String(url))) {
        written();
        return accepted.promise;
      }
      return gateway({ id: "doc-1", name: "Document one" });
    });
    const router = await renderRoute(resource, `/document/doc-1/${suffix}`);
    await waitFor(() => expect(element(".form-panel")).toBeDefined());
    const form = element<HTMLFormElement>(".form-panel");
    try {
      await act(async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))).toBe(false);
        }
      });
      await waitFor(() => expect(written).toHaveBeenCalledOnce());
      await act(async () => accepted.resolve(gateway({ id: "doc-1", name: "Updated" })));
      await waitFor(() => expect(router.history.location.pathname).toBe("/admin/document/doc-1"));
    } finally {
      await act(async () => accepted.resolve(gateway({ id: "doc-1" })));
    }
  });

  it("retains history identifiers and navigation when label hydration fails", async () => {
    fetch.mockImplementation(async (url) => String(url).endsWith("document.history")
      ? gateway({ fields: ["reviewerId"], events: [{
        ...historyEvent("2", "Latest"), actor: "previous-actor", values: { reviewerId: "reviewer" },
      }], nextCursor: null })
      : gateway({ invalid: "readMany must return an array" }));
    const onOpenRelation = vi.fn();
    const historyManifest = { ...manifest, history: { actor: { resource: "person" } } };
    await render(<HistoryMatrix manifest={historyManifest} resource={documentResource}
      recordId="doc-1" onOpenRelation={onOpenRelation} />);
    await act(async () => {
      const details = element<HTMLDetailsElement>("details");
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    await waitFor(() => expect(element('[role="alert"]').textContent).toContain("Identifiers are shown instead"));
    expect(fetch).toHaveBeenCalledWith("/admin/api/operations/person.read-many", expect.objectContaining({
      body: JSON.stringify({ input: { ids: ["reviewer", "previous-actor"] } }),
    }));
    await act(async () => element<HTMLAnchorElement>('a[href="/admin/person/previous-actor"]').click());
    expect(onOpenRelation).toHaveBeenCalledExactlyOnceWith("person", "previous-actor");
    expect(element('a[href="/admin/person/reviewer"]').textContent).toBe("reviewer");
  });

  it("keeps a multi-relation selection across searches and direct entry", async () => {
    const field: AtlasFieldManifest = {
      ...relationField, id: "reviewers", label: "Reviewers", schema: { type: "array", items: { type: "string" } },
      relation: { ...relationField.relation, cardinality: "many" },
    };
    const definition = { id: field.id, required: true, schema: field.schema };
    const lookup = Promise.withResolvers<Response>();
    const lookups: unknown[] = [];
    fetch.mockImplementation(async (url, options) => {
      const { input } = JSON.parse(String(options?.body));
      if (String(url).endsWith("person.read-many")) {
        return gateway(input.ids.includes("no-label") ? {} : input.ids.map((id: string) => ({ id, name: `Label ${id}` })));
      }
      lookups.push(input.search);
      if (input.search === undefined) {
        return Response.json({ error: "Unavailable" }, { status: 503 });
      }
      return lookup.promise;
    });
    const values = () => new FormData(element<HTMLFormElement>("form")).getAll(field.id);
    await render(<form><RelationInput definition={definition} field={field} manifest={manifest} value={["old"]} /></form>);
    await waitFor(() => expect(host.textContent).toContain("Label old"));
    const search = element<HTMLInputElement>('input[aria-label="Reviewers"]');
    await act(async () => search.focus());
    await waitFor(() => expect(document.body.textContent).toContain("Candidate lookup failed."));
    await act(async () => changeText(search, "new"));
    await waitFor(() => expect(lookups).toEqual([undefined, "new"]));
    await act(async () => lookup.resolve(gateway({
      items: [{ name: "Invalid candidate" }, { id: "new", name: "New reviewer" }], hasNextPage: false,
    })));
    await waitFor(() => expect(document.body.querySelector('[role="option"]')?.textContent).toContain("New reviewer"));
    await act(async () => document.body.querySelector<HTMLElement>('[role="option"]')?.click());
    expect(values()).toEqual(["old", "new"]);
    await act(async () => button("Enter identifiers directly").click());
    const direct = element<HTMLTextAreaElement>('textarea[aria-label="Reviewers identifiers"]');
    expect(direct.value).toBe("old\nnew");
    await act(async () => changeText(direct, "old\nno-label\nold\n"));
    expect(values()).toEqual(["old", "no-label"]);
    await act(async () => button("Search records instead").click());
    await waitFor(() => expect(host.textContent).toContain("no-label"));
    await act(async () => element<HTMLButtonElement>('button[aria-label="Remove old"]').click());
    expect(values()).toEqual(["no-label"]);
  });

  it.each([
    { cardinality: "one", schema: { type: ["integer", "null"] }, selector: 'input[aria-label="Reviewers identifier"]', value: " 42 ", expected: [42] },
    { cardinality: "many", schema: { type: "array", items: { type: "integer" } }, selector: "textarea", value: "42\r\n 042\n 7", expected: [42, 7] },
  ] as const)("hydrates $cardinality numeric relation identifiers entered directly", async ({ cardinality, schema, selector, value, expected }) => {
    const field: AtlasFieldManifest = {
      ...relationField, id: "reviewerIds", label: "Reviewers", schema,
      relation: { resource: "person", cardinality, optional: false },
    };
    const requested: unknown[] = [];
    fetch.mockImplementation(async (url, options) => {
      if (!String(url).endsWith("person.read-many")) throw new Error(`Unexpected operation ${String(url)}`);
      const { input: { ids } } = JSON.parse(String(options?.body));
      requested.push(ids);
      return ids.every((id: unknown) => typeof id === "number")
        ? gateway(ids.map((id: number) => ({ id, name: `Reviewer ${id}` })))
        : Response.json({ error: "Expected numeric identities" }, { status: 400 });
    });
    await render(<RelationInput definition={{ id: field.id, required: true, schema: field.schema }}
      field={field} manifest={manifest} />);
    await act(async () => button("Enter identifiers directly").click());
    await act(async () => changeText(element<HTMLInputElement | HTMLTextAreaElement>(selector), value));
    await act(async () => button("Search records instead").click());
    await waitFor(() => expect(host.textContent).toContain("Reviewer 42"));
    expect(requested).toEqual([expected]);
    expect([...host.querySelectorAll<HTMLInputElement>('input[name="reviewerIds"]')].map(({ value }) => value))
      .toEqual(expected.map(String));
  });

  it("keeps invalid numeric relation identifiers editable without submitting NaN or infinity to lookups", async () => {
    const field: AtlasFieldManifest = {
      ...relationField, id: "reviewerIds", label: "Reviewers", schema: { type: "array", items: { type: "integer" } },
      relation: { resource: "person", cardinality: "many", optional: true },
    };
    const requested: unknown[] = [];
    fetch.mockImplementation(async (_url, options) => {
      const { input: { ids } } = JSON.parse(String(options?.body));
      requested.push(ids);
      return Response.json({ error: "Invalid identifiers" }, { status: 400 });
    });
    await render(<form><RelationInput definition={{ id: field.id, required: false, schema: field.schema }}
      field={field} manifest={manifest} /></form>);
    const values = () => new FormData(element<HTMLFormElement>("form")).getAll(field.id);
    await act(async () => button("Enter identifiers directly").click());
    const input = element<HTMLTextAreaElement>('textarea[aria-label="Reviewers identifiers"]');
    await act(async () => changeText(input, "  \r\n   "));
    expect(values()).toStrictEqual([]);
    await act(async () => changeText(input, " nope \r\n Infinity \n 0 \n nope "));
    expect(values()).toStrictEqual(["nope", "Infinity", "0"]);
    await act(async () => button("Search records instead").click());
    await waitFor(() => expect(requested).toStrictEqual([["nope", "Infinity", 0]]));
    expect(values()).toStrictEqual(["nope", "Infinity", "0"]);
    await act(async () => button("Enter identifiers directly").click());
    expect(element<HTMLTextAreaElement>('textarea[aria-label="Reviewers identifiers"]').value).toBe("nope\nInfinity\n0");
  });

  it("hydrates selected relations in bounded batches without sharing labels across Atlas mounts", async () => {
    const field: AtlasFieldManifest = {
      ...relationField, relation: { resource: "person", cardinality: "many", optional: true },
    };
    const target = { ...person, readManyBatchSize: 1 };
    const requested: [string, string[]][] = [];
    fetch.mockImplementation(async (url, options) => {
      const mount = String(url).startsWith("/admin/") ? "/admin" : "/review";
      const { input } = JSON.parse(String(options?.body)) as { input: { ids: string[] } };
      requested.push([mount, input.ids]);
      return gateway(input.ids.map((id) => ({ id, name: `${mount}: ${id}` })));
    });
    for (const basePath of ["/admin", "/review"]) {
      await render(<RelationInput key={basePath}
        definition={{ id: field.id, required: false, schema: field.schema }}
        field={field} manifest={{ ...manifest, basePath, resources: [target] }}
        value={["p1", "p2"]} />);
      await waitFor(() => expect(host.textContent).toContain(`${basePath}: p2`));
    }
    expect(requested).toEqual([
      ["/admin", ["p1"]], ["/admin", ["p2"]],
      ["/review", ["p1"]], ["/review", ["p2"]],
    ]);
    expect(host.textContent).not.toContain("/admin: p1");
  });

  it("executes an inline action only after confirmation and leaves a refused request retryable", async () => {
    const action: AtlasRecordActionManifest = {
      ...notifyAction, id: "touch", label: "Touch", confirmation: "Update the record timestamp?",
      action: { ...notifyAction.action, effect: "destructive", inputs: [notifyAction.action.inputs[0]!] },
    };
    const execution = Promise.withResolvers<Response>();
    const requests: unknown[] = [];
    const resource = { ...documentResource, recordActions: [action] };
    fetch.mockImplementation(async (url, options) => {
      if (!String(url).endsWith("/record-actions/touch")) return gateway({ id: "doc-1", name: "Document one" });
      requests.push(JSON.parse(String(options?.body)));
      return requests.length === 1 ? execution.promise : Response.json({ data: {}, effects: [
        { type: "redirect", target: { resource: "person", recordId: "follow-up" } },
      ] });
    });
    const router = await renderRoute(resource, "/document/doc-1");
    await waitFor(() => expect(host.textContent).toContain("Document one"));
    await chooseRecordAction("Touch");
    const confirmation = document.querySelector('[role="alertdialog"]');
    expect(confirmation?.querySelector("h2")?.textContent).toBe("Touch?");
    expect(portalControl("Touch", '[role="alertdialog"] button').classList.contains("danger")).toBe(true);
    await act(async () => portalControl("Cancel", '[role="alertdialog"] button').click());
    expect(requests).toEqual([]);
    await chooseRecordAction("Touch");
    await act(async () => portalControl("Touch", '[role="alertdialog"] button').click());
    await waitFor(() => expect(requests).toHaveLength(1));
    await chooseRecordAction("Running…");
    expect(portalControl("Running…", '[role="menuitem"]').getAttribute("aria-disabled")).toBe("true");
    await act(async () => execution.resolve(Response.json({}, { status: 403 })));
    await waitFor(() => expect(document.body.textContent).toContain("Notice failed"));
    expect(portalControl("Touch", '[role="menuitem"]').getAttribute("aria-disabled")).toBeNull();
    await act(async () => portalControl("Touch", '[role="menuitem"]').click());
    await act(async () => portalControl("Touch", '[role="alertdialog"] button').click());
    await waitFor(() => expect(document.body.textContent).toContain("Notice sent"));
    await waitFor(() => expect(router.history.location.pathname).toBe("/admin/person/follow-up"));
    expect(requests).toEqual(Array.from({ length: 2 }, () => ({ input: { recordId: "doc-1" } })));
  });

  it("runs a parameterless record Action once when activated twice before pending renders", async () => {
    const action: AtlasRecordActionManifest = {
      ...notifyAction, action: { ...notifyAction.action, inputs: [{ ...numericId, id: "recordId" }] },
    };
    const execution = Promise.withResolvers<Response>();
    const requests: unknown[] = [];
    fetch.mockImplementation(async (url, options) => {
      if (!String(url).endsWith("/record-actions/notify")) return gateway({ id: 0, name: "Document one" });
      requests.push(JSON.parse(String(options?.body)));
      return execution.promise;
    });
    await renderRoute({ ...documentResource, recordActions: [action] }, "/document/0");
    await waitFor(() => expect(host.textContent).toContain("Document one"));
    await act(async () => button("Actions").click());
    const control = portalControl("Notify", '[role="menuitem"]');
    await act(async () => {
      control.click();
      control.click();
    });
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests).toEqual([{ input: { recordId: 0 } }]);
    await act(async () => execution.resolve(gateway({})));
  });

  it("opens a parameterized page action and returns to the record after success without a redirect", async () => {
    const { feedback: _feedback, ...rest } = notifyAction;
    const action = { ...rest, presentation: "page" as const, confirmation: "Send the notice?" };
    const inline = { ...action, id: "inline", label: "Refresh timestamp", action: {
      ...action.action, inputs: [notifyAction.action.inputs[0]!],
    } };
    const resource = { ...documentResource, recordActions: [action, inline] };
    fetch.mockImplementation(async (url) => String(url).includes("/record-actions/")
      ? gateway({})
      : gateway({ id: "doc-1", name: "Document one" }));
    const router = await renderRoute(resource, "/document/doc-1");
    await waitFor(() => expect(host.textContent).toContain("Document one"));
    await chooseRecordAction("Refresh timestamp");
    await act(async () => portalControl("Refresh timestamp", '[role="alertdialog"] button').click());
    await waitFor(() => expect(document.body.textContent).toContain("“Refresh timestamp” completed."));
    await chooseRecordAction("Notify");
    await waitFor(() => expect(router.history.location.pathname).toBe("/admin/document/doc-1/actions/notify"));
    await act(async () => button("Notify").click());
    expect(document.body.querySelector('[role="alertdialog"] h2')?.textContent).toBe("Notify?");
    expect(portalControl("Notify", '[role="alertdialog"] button').classList.contains("primary")).toBe(true);
    await act(async () => portalControl("Notify", '[role="alertdialog"] button').click());
    await waitFor(() => expect(router.history.location.pathname).toBe("/admin/document/doc-1"));
  });

  it("cycles sorting, resets its pagination, and updates the horizontal action affordance", async () => {
    const resource = { ...documentResource, fields: [{ ...nameField, sortable: true }] };
    const initial: AtlasCollectionQuery = { pagination: { type: "page", page: 4, pageSize: 10 } };
    const onQueryChange = vi.fn<(query: AtlasCollectionQuery) => void>();
    const onRead = vi.fn();
    const list = (collectionQuery: AtlasCollectionQuery) => <ResourceList manifest={manifest} resource={resource}
      collectionQuery={collectionQuery} onQueryChange={onQueryChange} onRead={onRead}
      onCreate={vi.fn()} onEdit={vi.fn()} onOpenAction={vi.fn()} onOpenRelation={vi.fn()} />;
    fetch.mockImplementation(async () => gateway({ items: [{ id: "doc-1", name: "Document one" }], pageInfo: { hasNextPage: true } }));
    await render(list(initial));
    await waitFor(() => expect(host.textContent).toContain("Document one"));
    const panel = element(".table-panel");
    Object.defineProperties(panel, { clientWidth: { value: 100 }, scrollWidth: { value: 150 } });
    await act(async () => panel.dispatchEvent(new Event("scroll")));
    expect(panel.classList.contains("show-action-shadow")).toBe(true);
    await act(async () => { panel.scrollLeft = 50; panel.dispatchEvent(new Event("scroll")); });
    expect(panel.classList.contains("show-action-shadow")).toBe(false);
    await act(async () => button("View").click());
    expect(onRead).toHaveBeenCalledExactlyOnceWith("doc-1");
    const firstPage = { ...initial.pagination, page: 1 };
    for (const [label, sorting] of [
      ["Name", [{ field: "name", direction: "asc" }]],
      ["Name ↑", [{ field: "name", direction: "desc" }]],
      ["Name ↓", undefined],
    ] as const) {
      await waitFor(() => expect(button(label)).toBeTruthy());
      await act(async () => button(label).click());
      expect(onQueryChange).toHaveBeenLastCalledWith({ pagination: firstPage, sorting });
      await render(list(onQueryChange.mock.lastCall![0]));
    }
  });

  it("keeps View pagination within the server page bounds while showing a pending page", async () => {
    const next = Promise.withResolvers<Response>();
    fetch.mockResolvedValueOnce(gateway({ items: [{ id: "first", name: "First page" }], pageInfo: { hasNextPage: true } }))
      .mockReturnValueOnce(next.promise);
    await render(<ResourceListView manifest={manifest} resource={documentResource}
      view={{ id: "recent", label: "Recent", renderer: "resource-list", query: operation("document.recent") }}
      onEdit={vi.fn()} onOpenAction={vi.fn()} onOpenRelation={vi.fn()} onRead={vi.fn()} />);
    await waitFor(() => expect(host.textContent).toContain("First page"));
    expect(button("Previous").disabled).toBe(true);
    await act(async () => button("Next").click());
    await waitFor(() => expect(host.textContent).toContain("Loading…"));
    expect(fetch).toHaveBeenLastCalledWith("/admin/api/operations/document.recent", expect.objectContaining({
      body: JSON.stringify({ input: { pagination: { type: "page", page: 2, pageSize: 20 } } }),
    }));
    await act(async () => next.resolve(gateway({ items: [{ id: "second", name: "Second page" }], pageInfo: { hasNextPage: false } })));
    await waitFor(() => expect(host.textContent).toContain("Second page"));
    expect(button("Next").disabled).toBe(true);
    await act(async () => button("Previous").click());
    expect(host.textContent).toContain("First page");
  });

  it.each(["list", "view"] as const)("routes row commands from the %s with encoded identities", async (surface) => {
    const recordId = "doc/one ?";
    const reviewerId = "person/one #";
    const record = { id: recordId, name: "Document one", reviewerId };
    const resource: AtlasResourceManifest = {
      ...documentResource,
      recordActions: [{ ...notifyAction, presentation: "page" }],
      views: [{ id: "recent", label: "Recent", renderer: "resource-list", query: operation("document.recent") }],
    };
    fetch.mockImplementation(async (url) => {
      switch (String(url).split("/").at(-1)) {
        case "document.list":
        case "document.recent": return gateway({ items: [record] });
        case "person.read-many": return gateway([{ id: reviewerId, name: "The reviewer" }]);
        case "person.read": return gateway({ id: reviewerId, name: "The reviewer" });
        case "document.read": return gateway(record);
        default: throw new Error(`Unexpected Atlas request: ${String(url)}`);
      }
    });
    const path = surface === "list" ? "/document" : "/document/views/recent";
    const router = await renderRoute(resource, path);
    const expectRow = () => waitFor(() => expect(host.querySelector('tbody a')?.textContent).toBe("The reviewer"));
    const reopenCollection = async () => {
      await act(async () => router.navigate({ to: path }));
      await expectRow();
    };
    const recordPath = `/admin/document/${encodeURIComponent(recordId)}`;
    await expectRow();
    expect(host.textContent).not.toContain("Create document");
    expect(host.querySelector('select[aria-label="Filter field"]') === null).toBe(surface === "view");
    await act(async () => button("View").click());
    expect(router.history.location.pathname).toBe(recordPath);
    await reopenCollection();
    await chooseRecordAction("Edit");
    expect(router.history.location.pathname).toBe(`${recordPath}/edit`);
    await reopenCollection();
    await chooseRecordAction("Notify");
    expect(router.history.location.pathname).toBe(`${recordPath}/actions/notify`);
    await reopenCollection();
    await act(async () => element<HTMLAnchorElement>("tbody a").click());
    expect(router.history.location.pathname).toBe(`/admin/person/${encodeURIComponent(reviewerId)}`);
  });

  it("updates shareable list pagination and search and opens the declared create page", async () => {
    const resource = {
      ...documentResource, fields: [{ ...nameField, sortable: true }],
      capabilities: { ...documentResource.capabilities, create: operation("document.create") },
    };
    const requests: unknown[] = [];
    fetch.mockImplementation(async (_url, options) => {
      const { input } = JSON.parse(String(options?.body));
      requests.push(input);
      return gateway({ items: [{ id: "one", name: "One" }], pageInfo: { hasNextPage: input.pagination.page === 1 } });
    });
    const router = await renderRoute(resource, "/document?q=old&pageSize=7&sort=name:desc");
    const pageOne = {
      pagination: { type: "page", page: 1, pageSize: 7 }, search: "old", sorting: [{ field: "name", direction: "desc" }],
    };
    await waitFor(() => expect(button("Next").disabled).toBe(false));
    expect(requests).toStrictEqual([pageOne]);
    await act(async () => button("Next").click());
    expect(router.history.location.pathname).toBe("/admin/document");
    expect(new URLSearchParams(router.history.location.search).get("page")).toBe("2");
    await waitFor(() => expect(host.textContent).toContain("Page 2"));
    expect(requests.at(-1)).toStrictEqual({ ...pageOne, pagination: { ...pageOne.pagination, page: 2 } });
    expect(button("Next").disabled).toBe(true);
    await act(async () => button("Clear").click());
    expect(new URLSearchParams(router.history.location.search).has("q")).toBe(false);
    expect(new URLSearchParams(router.history.location.search).has("page")).toBe(false);
    await waitFor(() => expect(requests.at(-1)).toStrictEqual({ pagination: pageOne.pagination, sorting: pageOne.sorting }));
    await act(async () => button("Create document").click());
    expect(router.history.location.pathname).toBe("/admin/document/create");
  });

  it("loads an embedded collection with fixed inputs while its host hides the controls", async () => {
    const query: AtlasCollectionQuery = { pagination: { type: "page", page: 1, pageSize: 8 } };
    const resource = { ...documentResource, fields: [{ ...nameField, sortable: true }] };
    const scope = { operation: operation("document.context"), input: { ownerId: "owner-1" } };
    const onRead = vi.fn();
    fetch.mockResolvedValueOnce(gateway({ items: [{ id: "one", name: "One" }], pageInfo: { hasNextPage: true } }));
    await render(<ResourceCollection manifest={manifest} resource={resource} collectionQuery={query}
      controlsVisible={false} features={{ search: true, filters: true, pagination: false, sorting: false, recordActions: false }}
      scope={scope} onRead={onRead} onEdit={vi.fn()} onOpenAction={vi.fn()} onOpenRelation={vi.fn()} onQueryChange={vi.fn()} />);
    await waitFor(() => expect(host.textContent).toContain("One"));
    expect(host.querySelector(".collection-controls")).toBeNull();
    expect(host.querySelector(".column-sort")).toBeNull();
    expect(host.querySelector(".pagination")).toBeNull();
    expect([...host.querySelectorAll("button")].map((control) => control.textContent?.trim())).toStrictEqual(["View"]);
    await act(async () => button("View").click());
    expect(onRead).toHaveBeenCalledExactlyOnceWith("one");
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/admin/api/operations/document.context", expect.objectContaining({
      body: JSON.stringify({ input: { ...query, ownerId: "owner-1" } }),
    }));
  });

  it("shows failures from invalid record data in both read and edit routes", async () => {
    fetch.mockImplementation(async () => gateway(null));
    const router = await renderRoute(documentResource, "/document/doc-1");
    await waitFor(() => expect(element('[role="alert"]').textContent).toContain("invalid result"));
    expect(host.querySelector(".detail-panel")).toBeNull();
    await act(async () => router.navigate({ to: "/document/doc-1/edit" }));
    await waitFor(() => expect(element('[role="alert"]').textContent).toContain("invalid result"));
    expect(host.querySelector("form")).toBeNull();
  });

  it("offers search for a related collection and keeps its fixed parent filter", async () => {
    const resource: AtlasResourceManifest = { ...documentResource, relatedCollections: [
      { id: "related", label: "Related people", resource: person.id, field: "parentId", pageSize: 5,
        features: { search: true, filters: false, pagination: false, sorting: false, recordActions: false } },
      { id: "contextual", label: "Contextual people", resource: person.id, field: "parentId", pageSize: 5,
        query: operation("person.context"), features: { search: false, filters: false, pagination: false, sorting: false, recordActions: false } },
    ] };
    const inputs: unknown[] = [];
    fetch.mockImplementation(async (url, options) => {
      const { input } = JSON.parse(String(options?.body));
      if (String(url).endsWith("person.list")) {
        inputs.push(input);
        return gateway({ items: [{ id: "related", name: "Related result" }] });
      }
      if (String(url).endsWith("person.context")) return Response.json({}, { status: 503 });
      return gateway({ id: "doc-1", name: "Document one" });
    });
    await renderRoute(resource, "/document/doc-1");
    await waitFor(() => expect(host.textContent).toContain("Related result"));
    expect(host.textContent).toContain("503");
    expect(host.querySelectorAll(".related-resource-controls-toggle")).toHaveLength(1);
    await act(async () => button("Search and filters").click());
    expect(host.querySelector('[aria-label="Filter field"]')).toBeNull();
    await act(async () => changeText(element<HTMLInputElement>('input[type="search"]'), "linked"));
    await act(async () => button("Search").click());
    await waitFor(() => expect(button("Search and filters (1)")).toBeTruthy());
    expect(inputs).toEqual([{
      pagination: { type: "page", page: 1, pageSize: 5 },
      filters: [{ field: "parentId", operator: "equals", value: "doc-1" }],
    }, {
      pagination: { type: "page", page: 1, pageSize: 5 }, search: "linked",
      filters: [{ field: "parentId", operator: "equals", value: "doc-1" }],
    }]);
    const controls = host.querySelector(".related-resource-controls-toggle");
    await act(async () => (controls as HTMLButtonElement).click());
    expect(controls?.getAttribute("aria-expanded")).toBe("false");
  });

  it("starts a cached parent record's related collection with a fresh query", async () => {
    const resource: AtlasResourceManifest = { ...documentResource, relatedCollections: [{
      id: "related", label: "Related people", resource: person.id, field: "parentId", pageSize: 5,
      features: { search: true, filters: true, pagination: true, sorting: false, recordActions: false },
    }] };
    const inputs: AtlasCollectionQuery[] = [];
    fetch.mockImplementation(async (url, options) => {
      if (!String(url).endsWith("person.list")) throw new Error(`Unexpected operation ${String(url)}`);
      const { input } = JSON.parse(String(options?.body));
      inputs.push(input);
      return gateway({ items: [{ id: "related", name: "Related result" }], pageInfo: { hasNextPage: true } });
    });
    for (const id of ["doc-1", "doc-2"]) {
      client.setQueryData([resource.id, "read", manifest.basePath, id], { data: { id, name: id }, effects: [] });
    }

    const router = await renderRoute(resource, "/document/doc-1");
    await waitFor(() => expect(button("Next").disabled).toBe(false));
    expect(button("Search and filters").getAttribute("aria-expanded")).toBe("false");
    await act(async () => button("Search and filters").click());
    expect(element('[aria-label="Filter field"]')).toBeTruthy();
    await act(async () => changeText(element<HTMLInputElement>('input[type="search"]'), "first parent"));
    await act(async () => button("Search").click());
    await waitFor(() => expect(button("Next").disabled).toBe(false));
    await act(async () => button("Next").click());
    await waitFor(() => expect(inputs.at(-1)?.pagination.page).toBe(2));

    await act(async () => router.navigate({ to: "/document/doc-2" }));
    const secondParent = { field: "parentId", operator: "equals", value: "doc-2" };
    await waitFor(() => expect(inputs.at(-1)?.filters).toEqual([secondParent]));
    expect(inputs.filter((query) => query.filters?.[0]?.value === "doc-2")).toEqual([{
      pagination: { type: "page", page: 1, pageSize: 5 }, filters: [secondParent],
    }]);
    expect(button("Search and filters").getAttribute("aria-expanded")).toBe("false");
  });

  it("uses numeric parent identities for both inverse and contextual collections", async () => {
    const features = { search: false, filters: false, pagination: false, sorting: false, recordActions: false };
    const resource: AtlasResourceManifest = { ...documentResource, relatedCollections: [{
      id: "inverse", label: "Inverse", resource: person.id, field: "parentId", pageSize: 5, features,
    }, {
      id: "context", label: "Contextual", resource: person.id, field: "parentId", pageSize: 5, features,
      query: { ...operation("person.context"), inputs: [{ ...numericId, id: "parentId" }] }, recordInput: "parentId",
    }] };
    fetch.mockImplementation(async (url) => String(url).endsWith("document.read")
      ? gateway({ id: 0, name: "Numeric parent" })
      : gateway({ items: [] }));
    await renderRoute(resource, "/document/0");
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/admin/api/operations/person.list", expect.objectContaining({
      body: JSON.stringify({ input: { pagination: { type: "page", page: 1, pageSize: 5 }, filters: [{ field: "parentId", operator: "equals", value: 0 }] } }),
    })));
    await waitFor(() => {
      const contextual = fetch.mock.calls.find(([url]) => String(url).endsWith("person.context"));
      expect(contextual).toBeDefined();
      expect(JSON.parse(String(contextual?.[1]?.body))).toEqual({
        input: { parentId: 0, pagination: { type: "page", page: 1, pageSize: 5 } },
      });
    });
  });

  it("binds the parent in a contextual collection and navigates to its related record actions", async () => {
    const features = { search: false, filters: true, pagination: false, sorting: false, recordActions: true };
    const resource: AtlasResourceManifest = { ...documentResource, relatedCollections: [{
      id: "team", label: "Team", resource: person.id, field: "teamId", pageSize: 5,
      query: operation("person.context"), recordInput: "teamId", features,
    }, {
      id: "others", label: "Others", resource: person.id, field: "teamId", pageSize: 5,
      query: operation("person.others"), features: { ...features, search: true, filters: false },
    }] };
    const relatedResource: AtlasResourceManifest = {
      ...person,
      fields: [nameField, scoreField, activeField],
      capabilities: { ...person.capabilities, update: documentResource.capabilities.update! },
      recordActions: [{ ...notifyAction, presentation: "page" }],
    };
    const contextualInputs: unknown[] = [];
    const unboundInputs: unknown[] = [];
    fetch.mockImplementation(async (url, options) => {
      const { input } = JSON.parse(String(options?.body));
      if (String(url).endsWith("person.context")) {
        contextualInputs.push(input);
        return gateway({ items: [{ id: "team/member", name: "Team member" }] });
      }
      if (String(url).endsWith("person.others")) {
        unboundInputs.push(input);
        return gateway({ items: [] });
      }
      return gateway({ id: input.id, name: "Loaded record" });
    });
    const parentPath = "/document/doc-1";
    const router = await renderRoute(resource, parentPath, relatedResource);
    const waitForCollection = () => waitFor(() => expect(host.textContent).toContain("Team member"));
    await waitForCollection();
    expect(contextualInputs).toEqual([{ pagination: { type: "page", page: 1, pageSize: 5 }, teamId: "doc-1" }]);
    expect(unboundInputs).toEqual([{ pagination: { type: "page", page: 1, pageSize: 5 } }]);
    const toggles = host.querySelectorAll<HTMLButtonElement>(".related-resource-controls-toggle");
    expect(toggles).toHaveLength(2);
    await act(async () => toggles[0]!.click());
    expect(element('[aria-label="Filter field"]')).toBeTruthy();

    await act(async () => button("Edit").click());
    await waitFor(() => expect(router.history.location.pathname).toBe("/admin/document/doc-1/edit"));
    await act(async () => router.navigate({ to: parentPath }));
    await waitForCollection();
    await chooseRecordAction("Edit");
    await waitFor(() => expect(router.history.location.pathname).toBe("/admin/person/team%2Fmember/edit"));
    await act(async () => router.navigate({ to: parentPath }));
    await waitForCollection();
    await chooseRecordAction("Notify");
    await waitFor(() => expect(router.history.location.pathname).toBe("/admin/person/team%2Fmember/actions/notify"));
    await act(async () => router.navigate({ to: parentPath }));
    await waitForCollection();
    await act(async () => button("View").click());
    await waitFor(() => expect(router.history.location.pathname).toBe("/admin/person/team%2Fmember"));
  });

  it("omits actions, history, errors and related filters that the record does not expose", async () => {
    const { update: _update, history: _history, ...capabilities } = documentResource.capabilities;
    const readOnly: AtlasResourceManifest = { ...documentResource, capabilities, relatedCollections: [{
      id: "team", label: "Team", resource: person.id, field: "teamId", pageSize: 5,
      query: operation("person.context"), features: {
        search: false, filters: true, pagination: false, sorting: false, recordActions: false,
      },
    }] };
    const unfilterable: AtlasResourceManifest = { ...person, fields: [{ ...nameField, filterOperators: [] }] };
    fetch.mockImplementation(async (url) => gateway(String(url).endsWith("person.context")
      ? { items: [] } : { id: "doc-1", name: "Document one" }));
    await renderRoute(readOnly, "/document/doc-1", unfilterable);
    await waitFor(() => expect(host.textContent).toContain("No records found."));
    expect(host.textContent).toContain("Team");
    expect(host.textContent).not.toMatch(/Edit|History|Search and filters/);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a record addressable when its relation labels cannot be loaded", async () => {
    const failed = () => Response.json({ error: "Unavailable" }, { status: 503 });
    fetch.mockImplementation(async (url) => String(url).endsWith("person.read-many") ? failed()
      : gateway(String(url).endsWith("document.list")
        ? { items: [{ id: "doc-1", name: "Document one", reviewerId: "reviewer" }] }
        : { id: "doc-1", name: "Document one", reviewerId: "reviewer" }));
    const router = await renderRoute(documentResource, "/document");
    await waitFor(() => expect(element('[role="alert"]').textContent).toContain("503"));
    expect(host.textContent).toContain("Document one");
    await act(async () => button("View").click());
    await waitFor(() => expect(router.history.location.pathname).toBe("/admin/document/doc-1"));
    await waitFor(() => expect(element('[role="alert"]').textContent).toContain("503"));
    expect(element('a[href="/admin/person/reviewer"]').textContent).toBe("reviewer");
  });

  it("keeps the displayed filter field and operator usable when the resource changes", async () => {
    const onChange = vi.fn();
    const query: AtlasCollectionQuery = { pagination: { type: "page", page: 3, pageSize: 10 } };
    const score = { ...scoreField, filterOperators: ["not-in"] as const };
    const active = { ...activeField, filterOperators: ["equals", "is-null", "is-not-null"] as const };
    const controls = (fields: readonly AtlasFieldManifest[], current = query) => (
      <CollectionControls onChange={onChange} query={current} resource={{ ...documentResource, fields }} />
    );
    const firstPage = { ...query.pagination, page: 1 };
    await render(controls([score, nameField]));
    const value = () => element<HTMLInputElement>('input[aria-label="Filter value"]');
    expect(value().placeholder).toBe("Comma-separated values");
    expect(host.textContent).not.toContain("Clear");
    expect(host.querySelector('[aria-label="Active filters"]')).toBeNull();
    await act(async () => button("Add filter").click());
    await act(async () => {
      changeText(value(), " , , ");
      button("Add filter").click();
    });
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => changeText(value(), "2, invalid, Infinity, -Infinity, 5"));
    await act(async () => button("Add filter").click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...query, pagination: firstPage, filters: [{ field: "score", operator: "not-in", value: [2, "invalid", "Infinity", "-Infinity", 5] }],
    });

    // A host can reuse its collection controls after a resource or view changes.
    await render(controls([active, nameField]));
    expect(element<HTMLSelectElement>('select[aria-label="Filter field"]').value).toBe("active");
    expect(element<HTMLSelectElement>('select[aria-label="Filter operator"]').value).toBe("equals");
    for (const [raw, normalized] of [[" true ", true], ["false", false], ["unrecognized", "unrecognized"]] as const) {
      await act(async () => changeText(value(), raw));
      await act(async () => button("Add filter").click());
      expect(onChange).toHaveBeenLastCalledWith({
        ...query, pagination: firstPage, filters: [{ field: "active", operator: "equals", value: normalized }],
      });
    }
    for (const selected of ["is-null", "is-not-null"] as const) {
      await act(async () => {
        const operator = element<HTMLSelectElement>('select[aria-label="Filter operator"]');
        operator.value = selected;
        operator.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(host.querySelector('input[aria-label="Filter value"]')).toBeNull();
      await act(async () => button("Add filter").click());
      expect(onChange).toHaveBeenLastCalledWith({
        ...query, pagination: firstPage, filters: [{ field: "active", operator: selected }],
      });
    }

    const saved: AtlasCollectionQuery = {
      ...query, search: "previous",
      filters: [{ field: "legacy", operator: "contains", value: "saved" }, { field: "active", operator: "is-null" }],
    };
    await render(controls([active, nameField], saved));
    expect(element<HTMLInputElement>('input[type="search"]').value).toBe("previous");
    expect([...host.querySelectorAll('button[title="Remove filter"]')].map((control) => control.textContent?.trim()))
      .toStrictEqual(["legacy contains saved ×", "Active is null ×"]);
    await act(async () => element<HTMLButtonElement>('button[title="Remove filter"]').click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...saved, pagination: firstPage, filters: [{ field: "active", operator: "is-null" }],
    });
    await act(async () => changeText(element<HTMLInputElement>('input[type="search"]'), "  "));
    await act(async () => button("Search").click());
    expect(onChange).toHaveBeenLastCalledWith({ ...saved, pagination: firstPage, search: undefined });
    await render(controls([active, nameField]));
    expect(element<HTMLInputElement>('input[type="search"]').value).toBe("");
  });
});
