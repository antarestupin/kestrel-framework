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
  RecordActionForm,
  RecordActionPage,
  ResourceCreatePage,
  ResourceEditPage,
  ResourceForm,
  ResourceList,
  ResourceListPage,
  ResourceReadPage,
  ResourceListView,
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

  async function renderRoute(resource: AtlasResourceManifest, path: string) {
    const activeManifest = { ...manifest, resources: [resource, person] };
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
    client.setQueryData(["person", "collection"], ["cached label"]);
    client.setQueryData(["outside-atlas"], ["unrelated data"]);
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
    expect(client.getQueryState(["person", "collection"])?.isInvalidated).toBe(false);

    await act(async () => button("Save").click());
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(submitted).toEqual(Array.from({ length: 2 }, () => ({
      id: "doc-1", name: "Edited name", reviewerId: "new",
    })));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(client.getQueryState(["person", "collection"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["outside-atlas"])?.isInvalidated).toBe(false);
  });

  it("keeps the editable record and typed values when a background refresh fails", async () => {
    fetch.mockResolvedValueOnce(gateway({ id: "doc-1", name: "Original name" }))
      .mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
    await render(<ResourceForm manifest={manifest} resource={documentResource} mode="update"
      recordId="doc-1" onCancel={vi.fn()} onSuccess={vi.fn()} />);
    await waitFor(() => expect(element<HTMLInputElement>('input[name="name"]').value).toBe("Original name"));
    await act(async () => changeText(element<HTMLInputElement>('input[name="name"]'), "Unsaved edit"));
    await act(async () => client.refetchQueries({ queryKey: ["document", "read", "doc-1"] }));
    await waitFor(() => expect(element('[role="alert"]').textContent).toContain("503"));
    expect(element<HTMLInputElement>('input[name="name"]').value).toBe("Unsaved edit");
    expect(button("Save").disabled).toBe(false);
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
    client.setQueryData(["document", "read", "doc-1"], { data: { id: "doc-1", active: true }, effects: [] });
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
    const confirmationButton = (label: string) => {
      const dialog = document.body.querySelector('[role="alertdialog"]');
      const control = [...dialog?.querySelectorAll("button") ?? []].find((candidate) => candidate.textContent?.trim() === label);
      if (control === undefined) throw new Error(`Atlas test could not find confirmation button "${label}"`);
      return control;
    };
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
    await act(async () => changeText(element<HTMLInputElement>('input[type="search"]'), "  new  "));
    await act(async () => button("Search").click());
    const firstPage = { ...query.pagination, page: 1 };
    expect(onChange).toHaveBeenLastCalledWith({ ...query, pagination: firstPage, search: "new" });
    await act(async () => button("Clear").click());
    expect(onChange).toHaveBeenLastCalledWith({ ...query, pagination: firstPage, search: undefined });

    await act(async () => {
      const field = element<HTMLSelectElement>('select[aria-label="Filter field"]');
      field.value = "score";
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(element<HTMLSelectElement>('select[aria-label="Filter operator"]').value).toBe("in");
    await act(async () => changeText(element<HTMLInputElement>('input[aria-label="Filter value"]'), " 1, 2, , 3 "));
    await act(async () => button("Add filter").click());
    const filter = { field: "score", operator: "in", value: [1, 2, 3] };
    expect(onChange).toHaveBeenLastCalledWith({ ...query, pagination: firstPage, filters: [filter] });
    await render(controls({ ...query, filters: [filter] } as AtlasCollectionQuery));
    await act(async () => element<HTMLButtonElement>('button[title="Remove filter"]').click());
    expect(onChange).toHaveBeenLastCalledWith({ ...query, pagination: firstPage, filters: undefined });
  });

  it("loads history only on demand and retries the failed older page", async () => {
    const cursors: unknown[] = [];
    const older = Promise.withResolvers<Response>();
    fetch.mockImplementation(async (_url, options) => {
      const { input } = JSON.parse(String(options?.body));
      cursors.push(input.before);
      if (input.before === undefined) {
        return gateway({ fields: ["name"], events: [historyEvent("2", "Latest")], nextCursor: "2" });
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
    await waitFor(() => expect(host.textContent).toContain("Latest"));
    await act(async () => button("Load older changes").click());
    await waitFor(() => expect(button("Load older changes").disabled).toBe(true));
    await act(async () => older.resolve(Response.json({ error: "temporarily unavailable" }, { status: 503 })));
    await waitFor(() => expect(element('[role="alert"]').textContent).toContain("could not be loaded"));
    expect(host.textContent).toContain("Latest");
    await act(async () => button("Retry").click());
    await waitFor(() => expect(cursors).toHaveLength(3));
    expect(cursors).toEqual([undefined, "2", "2"]);
    await waitFor(() => expect(host.textContent).toContain("Earlier"));
    expect(host.textContent?.indexOf("Earlier")).toBeLessThan(host.textContent?.indexOf("Latest") ?? 0);
    expect(host.querySelector('[role="alert"]')).toBeNull();
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
    client.setQueryData(["document", "read", "first"], first);
    client.setQueryData(["document", "read", "second"], second);
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

  it("keeps action inputs after refusal and follows the returned success target after retry", async () => {
    const resource = { ...documentResource, recordActions: [notifyAction] };
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
    const router = await renderRoute(resource, "/document/doc-1/actions/notify");
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
    expect(body).toEqual(Array.from({ length: 2 }, () => ({ input: { recordId: "doc-1", message: "Review is ready" } })));
  });

  it.each(["detail", "list"])("requires confirmation and retries failed deletion from the %s", async (surface) => {
    const resource = {
      ...documentResource,
      capabilities: { ...documentResource.capabilities, delete: {
        ...operation("document.delete"), effect: "destructive" as const,
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
        ? { items: submitted.length > 1 ? [] : [{ id: "doc-1", name: "Document one" }], hasNextPage: false }
        : { id: "doc-1", name: "Document one" });
    });
    const router = await renderRoute(resource, surface === "detail" ? "/document/doc-1" : "/document");
    await waitFor(() => expect(host.textContent).toContain("Document one"));
    await chooseRecordAction("Delete");
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
    expect(submitted).toEqual([{ input: { id: "doc-1" } }, { input: { id: "doc-1" } }]);
  });

  it("asks before discarding a populated action dialog, then follows its success redirect", async () => {
    const resource = { ...documentResource, recordActions: [notifyAction] };
    const submitted: unknown[] = [];
    fetch.mockImplementation(async (url, options) => {
      if (String(url).endsWith("/record-actions/notify")) {
        submitted.push(JSON.parse(String(options?.body)));
        return Response.json({ data: {}, effects: [
          { type: "redirect", target: { resource: "person", recordId: "linked" } },
        ] });
      }
      return gateway({ id: "doc-1", name: "Document one" });
    });
    const router = await renderRoute(resource, "/document/doc-1");
    await waitFor(() => expect(host.textContent).toContain("Document one"));
    await chooseRecordAction("Notify");
    expect(document.body.querySelector('[role="dialog"] a')?.getAttribute("href")).toBe("/admin/document/doc-1/actions/notify");
    await act(async () => portalControl("Cancel", '[role="dialog"] button').click());
    await waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());

    await chooseRecordAction("Notify");
    const messageInput = document.body.querySelector<HTMLInputElement>('[role="dialog"] input[name="message"]')!;
    await act(async () => changeText(messageInput, "Keep this text"));
    await act(async () => portalControl("Cancel", '[role="dialog"] button').click());
    await waitFor(() => expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain("Discard the entered values?"));
    await act(async () => portalControl("Cancel", '[role="alertdialog"] button').click());
    expect(messageInput.value).toBe("Keep this text");

    await act(async () => portalControl("Cancel", '[role="dialog"] button').click());
    await act(async () => portalControl("Discard", '[role="alertdialog"] button').click());
    await waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
    expect(submitted).toEqual([]);

    await chooseRecordAction("Notify");
    await act(async () => portalControl("Notify", '[role="dialog"] button').click());
    await waitFor(() => expect(router.history.location.pathname).toBe("/admin/person/linked"));
    expect(submitted).toEqual([{ input: { recordId: "doc-1" } }]);
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
        return gateway(submitted.length === 1 ? { id: "new-id" } : {});
      }
      return gateway(String(url).endsWith("document.list")
        ? { items: [], hasNextPage: false } : { id: "new-id", name: "New document" });
    });
    const router = await renderRoute(resource, "/document/create");
    for (const [title, destination] of [["First", "/admin/document/new-id"], ["Second", "/admin/document"]]) {
      await act(async () => changeText(element<HTMLInputElement>('input[name="name"]'), title!));
      await act(async () => button("Save").click());
      await waitFor(() => expect(router.history.location.pathname).toBe(destination));
      if (title === "First") await act(async () => router.navigate({ to: "/document/create" }));
    }
    expect(submitted).toEqual([{ input: { name: "First" } }, { input: { name: "Second" } }]);
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
    const active = { ...activeField, filterOperators: ["equals", "is-null"] as const };
    const controls = (fields: readonly AtlasFieldManifest[], current = query) => (
      <CollectionControls onChange={onChange} query={current} resource={{ ...documentResource, fields }} />
    );
    const firstPage = { ...query.pagination, page: 1 };
    await render(controls([score, nameField]));
    const value = () => element<HTMLInputElement>('input[aria-label="Filter value"]');
    await act(async () => button("Add filter").click());
    await act(async () => {
      changeText(value(), " , , ");
      button("Add filter").click();
    });
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => changeText(value(), "2, invalid, 5"));
    await act(async () => button("Add filter").click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...query, pagination: firstPage, filters: [{ field: "score", operator: "not-in", value: [2, "invalid", 5] }],
    });

    // A host can reuse its collection controls after a resource or view changes.
    await render(controls([active, nameField]));
    expect(element<HTMLSelectElement>('select[aria-label="Filter field"]').value).toBe("active");
    expect(element<HTMLSelectElement>('select[aria-label="Filter operator"]').value).toBe("equals");
    for (const [raw, normalized] of [["true", true], ["false", false], ["unrecognized", "unrecognized"]] as const) {
      await act(async () => changeText(value(), raw));
      await act(async () => button("Add filter").click());
      expect(onChange).toHaveBeenLastCalledWith({
        ...query, pagination: firstPage, filters: [{ field: "active", operator: "equals", value: normalized }],
      });
    }
    await act(async () => {
      const operator = element<HTMLSelectElement>('select[aria-label="Filter operator"]');
      operator.value = "is-null";
      operator.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Add filter").click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...query, pagination: firstPage, filters: [{ field: "active", operator: "is-null" }],
    });

    const saved: AtlasCollectionQuery = {
      ...query, search: "previous",
      filters: [{ field: "legacy", operator: "contains", value: "saved" }, { field: "active", operator: "is-null" }],
    };
    await render(controls([active, nameField], saved));
    expect(host.textContent).toContain("legacy contains saved");
    await act(async () => element<HTMLButtonElement>('button[title="Remove filter"]').click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...saved, pagination: firstPage, filters: [{ field: "active", operator: "is-null" }],
    });
    await act(async () => changeText(element<HTMLInputElement>('input[type="search"]'), "  "));
    await act(async () => button("Search").click());
    expect(onChange).toHaveBeenLastCalledWith({ ...saved, pagination: firstPage, search: undefined });
  });
});
