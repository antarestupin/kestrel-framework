// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, Outlet } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import type { AtlasManifest, AtlasOperationManifest } from "../../contract.js";
import { createAtlasRouter } from "./router.js";

it("loads the default home, collection, record, form, Action and View renderers through their routes", async () => {
  const read: AtlasOperationManifest = { id: "entry.read", sourceId: "app", effect: "read", inputs: [] };
  const list: AtlasOperationManifest = { ...read, id: "entry.list" };
  const write: AtlasOperationManifest = { ...read, id: "entry.write", effect: "write", inputs: [
    { id: "id", required: true, schema: { type: "string" } },
  ] };
  const manifest: AtlasManifest = {
    basePath: "/atlas", title: "Management", icons: {},
    defaults: { recordActionsInList: "all", textMaxLength: 50 }, notifications: { position: "bottom-left" },
    resources: [{
      id: "entry", label: "Entries", labelSingular: "Entry", identity: "id", displayField: "name", sourceId: "app",
      fields: [], capabilities: { list, read, readMany: read, create: write, update: write },
      views: [{ id: "recent", label: "Recent entries", renderer: "resource-list", query: list }],
      recordActions: [{ id: "refresh", label: "Refresh entry", recordInput: "id", presentation: "page", action: write }],
    }],
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => Response.json({
    data: String(url).endsWith("entry.list") ? { items: [] } : { id: "one", name: "Entry one" }, effects: [],
  }));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });

  try {
    // Isolate route renderers from the theme and navigation chrome.
    const { router, RouterProvider } = createAtlasRouter(manifest, { registries: { pages: { layout: Outlet } } });
    router.update({ history: createMemoryHistory({ initialEntries: ["/atlas"] }) });
    await act(async () => {
      await router.load();
      root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
    });

    const heading = async (text: string) => vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.querySelector("h1")?.textContent).toBe(text);
    });
    await heading("Management");
    expect(host.querySelector("a.resource-card")?.getAttribute("href")).toBe("/atlas/entry");
    for (const [path, title] of [
      ["/entry", "Entries"], ["/entry/one", "Entry one"], ["/entry/create", "Create Entry"],
      ["/entry/one/edit", "Edit record"], ["/entry/one/actions/refresh", "Refresh entry"],
      ["/entry/views/recent", "Recent entries"],
    ] as const) {
      await act(async () => router.navigate({ to: path }));
      await heading(title);
    }
  } finally {
    try {
      await act(async () => root.unmount());
    } finally {
      client.clear();
      host.remove();
      vi.unstubAllGlobals();
    }
  }
});
