// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AtlasManifest } from "../../contract.js";
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
    expect(host.querySelector('section[aria-label="Inventory"] a[href="/atlas/items/views/recent"]')?.textContent).toBe("Recent");
    expect(host.querySelector('section[aria-label="Resources"] a[href="/atlas/users"]')?.textContent).toBe("Users");
    expect(document.querySelector("link[data-atlas-favicon]")?.getAttribute("href")).toBe("/brand.svg");
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
    host.dataset.atlasConfig = encodeURIComponent(JSON.stringify({ ...configuration, authentication }));
    window.history.replaceState(null, "", authentication.loginPath);
    await start();

    expect(host.querySelector("h1")?.textContent).toBe("Sign in to Atlas workspace");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "__ATLAS_CLIENT_CONFIG__", "%broken"])(
    "renders a startup error when the injected configuration is %s",
    async (value) => {
      if (value !== undefined) host.dataset.atlasConfig = value;
      await start();
      expect(host.querySelector("h1")?.textContent).toBe("Unable to load Atlas");
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
});
