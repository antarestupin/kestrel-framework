// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { HistoryMatrix } from "./history_matrix.js";
import { CollectionControls, RecordActionForm, ResourceForm } from "./pages.js";

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
});
