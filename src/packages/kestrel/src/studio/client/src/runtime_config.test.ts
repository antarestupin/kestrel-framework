import { describe, expect, it, vi } from "vitest";

import { loadStudioManifest, readStudioClientConfig } from "./runtime_config.js";

describe("Studio browser startup", () => {
  it.each([
    ["/", "/api/manifest"],
    ["/tools/studio", "/tools/studio/api/manifest"],
  ])("loads the server manifest from mount %s", async (basePath, url) => {
    const manifest = { basePath, extensions: [], icons: {} };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(manifest));
    try {
      await expect(loadStudioManifest(basePath)).resolves.toEqual(manifest);
      expect(fetch).toHaveBeenCalledExactlyOnceWith(url, { headers: { accept: "application/json" } });
    } finally {
      fetch.mockRestore();
    }
  });

  it("reports an unsuccessful manifest request before decoding its body", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unavailable", { status: 503 }));
    try {
      await expect(loadStudioManifest("/_studio")).rejects.toThrow("manifest request failed with status 503");
    } finally {
      fetch.mockRestore();
    }
  });

  it("reads injected data and tolerates the build placeholder or missing root", () => {
    const config = { basePath: "/tools", sourcePathMapping: { runtimeRoot: "/srv", editorRoot: "/work" } };
    const querySelector = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ dataset: { studioConfig: "__STUDIO_CLIENT_CONFIG__" } })
      .mockReturnValueOnce({ dataset: { studioConfig: encodeURIComponent(JSON.stringify(config)) } });
    vi.stubGlobal("document", { querySelector });
    try {
      expect(readStudioClientConfig()).toBeUndefined();
      expect(readStudioClientConfig()).toBeUndefined();
      expect(readStudioClientConfig()).toEqual(config);
      expect(querySelector).toHaveBeenCalledWith("#root");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
