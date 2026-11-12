// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AtlasManifest } from "../../contract.js";
import { AtlasApplication } from "./app.js";
import { bootstrapAtlas } from "./bootstrap.js";

const configuration = { basePath: "/atlas", title: "Atlas workspace" };
const manifest: AtlasManifest = {
  ...configuration,
  defaults: { textMaxLength: 50, recordActionsInList: "all" },
  icons: {},
  notifications: { position: "bottom-left" },
  resources: [],
};
const authentication = {
  loginPath: "/atlas/login",
  passwordSignInUrl: "/sign-in",
  signOutUrl: "/sign-out",
};
const operation = { id: "items.read", sourceId: "app", effect: "read", inputs: [] } as const;

describe("Atlas document startup", () => {
  let host: HTMLDivElement;
  let root: Root | undefined;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    root = undefined;
    host = document.createElement("div");
    host.id = "root";
    document.body.append(host);
    window.history.replaceState(null, "", "/atlas");
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
  });

  afterEach(async () => {
    try {
      if (root !== undefined) await act(async () => root?.unmount());
    } finally {
      host.remove();
      document.querySelectorAll("[data-atlas-appearance], [data-atlas-favicon]").forEach((node) => node.remove());
      delete document.documentElement.dataset.theme;
      document.documentElement.style.removeProperty("color-scheme");
      window.history.replaceState(null, "", "/");
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  async function start() {
    await act(async () => { root = await bootstrapAtlas(); });
  }

  it("loads the manifest and renders the protected application", async () => {
    const branding = { logo: { src: "/brand.svg", alt: "Company" } };
    host.dataset.atlasConfig = encodeURIComponent(JSON.stringify({ ...configuration, authentication, branding }));
    fetchMock.mockResolvedValueOnce(Response.json({
      ...manifest,
      branding,
      resources: [{
        id: "items", label: "Items", labelSingular: "Item", identity: "id", displayField: "id", sourceId: "app",
        fields: [], capabilities: { list: operation, read: operation, readMany: operation }, recordActions: [],
        navigationGroup: "Inventory",
        views: [{ id: "recent", label: "Recent", renderer: "resource-list", query: operation }],
      }, {
        id: "users", label: "Users", labelSingular: "User", identity: "id", displayField: "id", sourceId: "app",
        fields: [], capabilities: { list: operation, read: operation, readMany: operation }, recordActions: [], views: [],
      }],
    } satisfies AtlasManifest));
    await start();

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/atlas/api/manifest", {
      headers: { accept: "application/json" },
    });
    expect(host.querySelector(".sidebar")).not.toBeNull();
    expect(host.textContent).toContain("Sign out");
    expect(host.querySelector('section[aria-label="Inventory"] h2')?.textContent).toBe("Inventory");
    expect(host.querySelector('section[aria-label="Resources"] h2')?.textContent).toBe("Resources");
    expect(host.querySelector('section[aria-label="Inventory"] a[href="/atlas/items/views/recent"]')?.textContent).toBe("Recent");
    expect(host.querySelector('section[aria-label="Resources"] a[href="/atlas/users"]')?.textContent).toBe("Users");
    expect(document.querySelector("link[data-atlas-favicon]")?.getAttribute("href")).toBe("/brand.svg");
  });

  it("marks active navigation and reuses a fresh collection on quick return", async () => {
    host.dataset.atlasConfig = encodeURIComponent(JSON.stringify(configuration));
    const list = { ...operation, id: "items.list" };
    fetchMock.mockImplementation(async (url) => String(url).endsWith("/api/manifest")
      ? Response.json({ ...manifest, resources: [{
        id: "items", label: "Items", labelSingular: "Item", identity: "id", displayField: "id", sourceId: "app",
        fields: [{ id: "id", label: "ID", kind: "text", schema: { type: "string" }, hidden: false, readOnly: true, searchable: false, sortable: false, filterOperators: [] }],
        capabilities: { list, read: operation, readMany: operation }, recordActions: [],
        views: [{ id: "recent", label: "Recent", renderer: "resource-list", query: list }],
      }] } satisfies AtlasManifest)
      : Response.json({ data: { items: [{ id: "item-one" }] }, effects: [] }));
    await start();

    const select = async (selector: string) => {
      const link = host.querySelector<HTMLAnchorElement>(selector);
      expect(link).not.toBeNull();
      await act(async () => link?.click());
    };
    const readCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/operations/items.list"));
    const loaded = () => vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.querySelector("tbody")?.textContent).toContain("item-one");
    });

    await select('.nav-link[href="/atlas/items"]');
    await loaded();
    expect(host.querySelector('.nav-link.active[href="/atlas/items"]')).not.toBeNull();
    expect(readCalls()).toHaveLength(1);
    await select(".brand");
    await vi.waitFor(() => expect(host.querySelector("h1")?.textContent).toBe("Atlas workspace"));
    await select('.nav-link[href="/atlas/items"]');
    await loaded();
    expect(readCalls()).toHaveLength(1);

    await select('.nav-subitem[href="/atlas/items/views/recent"]');
    await vi.waitFor(() => expect(host.querySelector("h1")?.textContent).toBe("Recent"));
    expect(host.querySelector('.nav-subitem.active[href="/atlas/items/views/recent"]')).not.toBeNull();
  });

  it("links back to the overview from an unknown route", async () => {
    host.dataset.atlasConfig = encodeURIComponent(JSON.stringify(configuration));
    window.history.replaceState(null, "", "/atlas/unknown");
    fetchMock.mockResolvedValueOnce(Response.json(manifest));
    await start();
    expect(host.textContent).toContain("Page not found");
    expect(host.querySelector("main a")?.getAttribute("href")).toBe("/atlas/");
    expect(host.textContent).not.toContain("Sign out");
  });

  it("mounts the login document without requesting the protected manifest", async () => {
    host.dataset.atlasConfig = encodeURIComponent(JSON.stringify({ ...configuration, authentication, theme: { primaryColor: "#123456" } }));
    window.history.replaceState(null, "", authentication.loginPath);
    await start();

    expect(host.querySelector("h1")?.textContent).toBe("Sign in to Atlas workspace");
    expect(document.querySelector("style[data-atlas-appearance]")?.textContent).toContain("--atlas-accent:#123456");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "__ATLAS_CLIENT_CONFIG__", "%broken"])(
    "renders a startup error when the injected configuration is %s",
    async (value) => {
      if (value !== undefined) host.dataset.atlasConfig = value;
      await start();
      expect(host.querySelector("h1")?.textContent).toBe("Unable to load Atlas");
      if (value !== "%broken") expect(host.textContent).toContain("Atlas client configuration was not injected.");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("renders a manifest HTTP failure in the startup screen", async () => {
    host.dataset.atlasConfig = encodeURIComponent(JSON.stringify(configuration));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await start();
    expect(host.textContent).toContain("Atlas manifest request failed with status 503.");
  });

  it("uses a stable startup message for a non-Error rejection", async () => {
    host.dataset.atlasConfig = encodeURIComponent(JSON.stringify(configuration));
    fetchMock.mockRejectedValueOnce("offline");
    await start();
    expect(host.textContent).toContain("Atlas failed to start.");
  });

  it("rejects startup without a document mount", async () => {
    host.remove();
    await expect(bootstrapAtlas()).rejects.toThrow("could not find its root element");
  });

  it("honors the legacy page override and refreshes embedded renderers when props change", async () => {
    root = createRoot(host);
    const registries = { pages: { home: () => <h1>Registry home</h1> } };
    const first = { home: () => <h1>First override</h1> };
    const second = { home: () => <h1>Second override</h1> };
    await act(async () => root!.render(<AtlasApplication manifest={manifest} registries={registries} pageRenderers={first} />));
    expect(host.querySelector("h1")?.textContent).toBe("First override");
    await act(async () => root!.render(<AtlasApplication manifest={manifest} registries={registries} pageRenderers={second} />));
    await vi.waitFor(() => expect(host.querySelector("h1")?.textContent).toBe("Second override"));
    await act(async () => root!.render(<AtlasApplication manifest={manifest} registries={registries} />));
    await vi.waitFor(() => expect(host.querySelector("h1")?.textContent).toBe("Registry home"));
  });

  it("uses an explicitly supplied legacy View renderer ahead of the registry default", async () => {
    const embedded: AtlasManifest = { ...manifest, resources: [{
      id: "items", label: "Items", labelSingular: "Item", identity: "id", displayField: "id", sourceId: "app",
      fields: [], capabilities: { list: operation, read: operation, readMany: operation }, recordActions: [],
      views: [{ id: "recent", label: "Recent", renderer: "custom", query: operation }],
    }] };
    window.history.replaceState(null, "", "/atlas/items/views/recent");
    root = createRoot(host);
    await act(async () => root!.render(<AtlasApplication manifest={embedded}
      registries={{ views: { custom: () => <h1>Registry View</h1> } }}
      viewRenderers={{ custom: () => <h1>Explicit View</h1> }} />));
    await vi.waitFor(() => expect(host.querySelector("h1")?.textContent).toBe("Explicit View"));
  });
});
