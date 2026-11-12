// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudioManifest } from "../../extension.js";
import { bootstrapStudio } from "./bootstrap.js";

const configuration = { basePath: "/studio" };
const manifest: StudioManifest = {
  ...configuration,
  icons: {},
  extensions: [],
};

describe("Studio document startup", () => {
  let host: HTMLDivElement;
  let root: Root | undefined;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    root = undefined;
    host = document.createElement("div");
    host.id = "root";
    document.body.append(host);
    window.history.replaceState(null, "", "/studio");
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    try {
      if (root !== undefined) await act(async () => root?.unmount());
    } finally {
      host.remove();
      window.history.replaceState(null, "", "/");
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  async function start() {
    await act(async () => { root = await bootstrapStudio(); });
  }

  it("loads the manifest under its mount and renders the workspace", async () => {
    host.dataset.studioConfig = encodeURIComponent(JSON.stringify(configuration));
    fetchMock.mockResolvedValueOnce(Response.json(manifest));
    await start();

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/studio/api/manifest", {
      headers: { accept: "application/json" },
    });
    expect(host.textContent).toContain("See how your application is wired.");
  });

  it("shows visible pages and external links and groups their counts", async () => {
    host.dataset.studioConfig = encodeURIComponent(JSON.stringify(configuration));
    const configured: StudioManifest = {
      ...manifest,
      extensions: [{
        id: "tools", title: "Tools", description: "Deployment tools",
        section: { id: "ops", title: "Operations" },
        pages: [
          { id: "one", kind: "custom-kind", path: "/one", title: "First" },
          { id: "two", kind: "custom-kind", path: "/two", title: "Second" },
          { id: "hidden", kind: "custom-kind", path: "/hidden", title: "Hidden", showInNavigation: false },
        ],
        links: [{ id: "runbook", href: "https://example.test/runbook", title: "Runbook", description: "On-call reference" }],
      }, {
        id: "docs", title: "Documentation", pages: [], section: { id: "docs", title: "Documentation" },
        links: [
          { id: "one", href: "https://example.test/one", title: "One" },
          { id: "two", href: "https://example.test/two", title: "Two" },
        ],
      }, {
        id: "empty", title: "Empty extension", pages: [], section: { id: "empty", title: "Empty" },
      }, {
        id: "single", title: "Single tool", section: { id: "single", title: "Single" },
        pages: [{ id: "single", kind: "custom-kind", path: "/single", title: "Single" }],
      }],
    };
    fetchMock.mockResolvedValueOnce(Response.json(configured));
    await start();

    const runbook = host.querySelector<HTMLAnchorElement>('a[href="https://example.test/runbook"]');
    expect(runbook?.target).toBe("_blank");
    expect(runbook?.title).toBe("On-call reference");
    expect(host.querySelector('a[href="/studio/one"]')?.textContent).toBe("First");
    expect(host.querySelector('a[href="/studio/hidden"]')).toBeNull();
    expect([...host.querySelectorAll(".extension-card span")].map((node) => node.textContent))
      .toEqual(["2 pages · 1 link", "2 links", "No resources", "1 page"]);
  });

  it.each([
    ["/studio/extension", "Renderer not installed"],
    ["/studio/unknown", "Page not found"],
  ])("provides a fallback at %s", async (path, heading) => {
    host.dataset.studioConfig = encodeURIComponent(JSON.stringify(configuration));
    window.history.replaceState(null, "", path);
    fetchMock.mockResolvedValueOnce(Response.json({
      ...manifest,
      extensions: [{
        id: "tools", title: "Tools", section: { id: "tools", title: "Tools" },
        pages: [{
          id: "extension", kind: "unknown-renderer", path: "/extension",
          title: "Extension page", description: "Custom tool",
        }],
      }],
    } satisfies StudioManifest));
    await start();

    expect(host.textContent).toContain(heading);
    if (path === "/studio/extension") expect(host.textContent).toContain("Custom tool");
    else expect(host.querySelector("main a")?.getAttribute("href")).toBe("/studio/");
  });

  it.each([undefined, "%broken"])("renders a startup error when configuration is %s", async (value) => {
    if (value !== undefined) host.dataset.studioConfig = value;
    await start();
    expect(host.querySelector("h1")?.textContent).toBe("Unable to load Studio");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a stable startup message for a non-Error rejection", async () => {
    host.dataset.studioConfig = encodeURIComponent(JSON.stringify(configuration));
    fetchMock.mockRejectedValueOnce("offline");
    await start();
    expect(host.textContent).toContain("Studio failed to start.");
  });

  it("rejects startup without a document mount", async () => {
    host.remove();
    await expect(bootstrapStudio()).rejects.toThrow("could not find its root element");
  });
});
