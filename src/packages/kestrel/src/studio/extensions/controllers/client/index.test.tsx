// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadStudioPageRenderer } from "../../../client/src/extensions.js";
import type { StudioPageManifest } from "../../../extension.js";
import {
  CONTROLLERS_STUDIO_PAGE_KIND,
  type StudioHttpControllerCatalog,
  type StudioHttpControllerDefinition,
} from "../contract.js";

const page = {
  id: "controllers",
  kind: CONTROLLERS_STUDIO_PAGE_KIND,
  path: "/controllers",
  title: "HTTP controllers",
  dataPath: "/studio/controllers",
} as const satisfies StudioPageManifest;

const controller: StudioHttpControllerDefinition = {
  kind: "controller",
  id: "widgets.update",
  name: "Update widget",
  method: "POST",
  url: "/api/widgets/:id",
  access: "authenticated",
  description: "Update the widget's label.",
  inputs: [
    { name: "id", sourceName: "id", binding: "path", required: true, schema: { type: "string" } },
    { name: "query", sourceName: "mode", binding: "query", required: false, schema: true },
    { name: "label", sourceName: "name", binding: "body", required: true, schema: { type: "string" } },
  ],
  examples: [
    { name: "Standard", input: { id: "one", label: "Initial" } },
    { name: "Preview", input: { id: "two/three", query: "dry run", label: "Preview name" } },
  ],
};

describe("Studio HTTP controller explorer interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let request: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  async function render(manifest: StudioPageManifest = page) {
    const renderer = await loadStudioPageRenderer(CONTROLLERS_STUDIO_PAGE_KIND);
    expect(renderer).toBeDefined();
    await act(async () => root.render(renderer!.render(manifest)));
  }

  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")]
      .find((element) => element.textContent?.includes(label));
    if (found === undefined) throw new Error(`Missing button: ${label}`);
    return found;
  }

  it("populates a selected example and distinguishes HTTP and network failures", async () => {
    const catalog = Promise.withResolvers<Response>();
    const response = Promise.withResolvers<Response>();
    request
      .mockReturnValueOnce(catalog.promise)
      .mockReturnValueOnce(response.promise)
      .mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await render();
    expect(container.textContent).toContain("Loading HTTP controllers");
    const catalogData: StudioHttpControllerCatalog = {
      nodes: [{
        id: "widgets", name: "Widgets", kind: "group", children: [controller],
      }],
    };
    await act(async () => catalog.resolve(Response.json(catalogData)));
    await act(async () => button("Collapse all").click());
    expect(container.querySelector("details")?.open).toBe(false);
    await act(async () => container.querySelector("summary")!.click());
    expect(container.querySelector("details")?.open).toBe(true);

    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("textarea")?.value).toContain('"name": "Preview name"');

    await act(async () => button("Send request").click());
    expect(button("Sending").disabled).toBe(true);
    expect(request).toHaveBeenLastCalledWith("/api/widgets/two%2Fthree?mode=dry+run", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ name: "Preview name" }, null, 2),
    });
    await act(async () => response.resolve(Response.json({ error: "Rejected" }, {
      status: 422,
      statusText: "Unprocessable Content",
      headers: { "x-test": "response" },
    })));
    expect(container.querySelector(".controller-response .failure")?.textContent).toContain("422");
    expect(container.querySelector(".controller-response")?.textContent).toContain('"error": "Rejected"');
    expect(container.querySelector(".controller-response")?.textContent).toContain("x-test: response");

    await act(async () => button("Send request").click());
    expect(container.textContent).toContain("Network unavailable");
    expect(container.querySelector(".controller-response")).toBeNull();
    expect(button("Send request").disabled).toBe(false);

    await act(async () => button("Send request").click());
    expect(container.querySelector(".controller-response .success")?.textContent).toContain("204");
    expect(container.querySelector(".controller-response")?.textContent).toContain("(empty response)");
  });

  it("withdraws the previous controller while a different catalog is loading", async () => {
    const nextCatalog = Promise.withResolvers<Response>();
    request.mockResolvedValueOnce(Response.json({ nodes: [controller] }))
      .mockReturnValueOnce(nextCatalog.promise);
    await render();
    expect(button("Send request").disabled).toBe(false);

    await render({ ...page, dataPath: "/studio/other-controllers" });
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    // Switching catalog endpoints must not leave a previous mutation available.
    expect(container.textContent).toContain("Loading HTTP controllers");
    expect(container.textContent).not.toContain("Send request");

    await act(async () => nextCatalog.resolve(new Response(null, { status: 403 })));
    expect(container.textContent).toContain("Unable to load HTTP controllers (403).");
    expect(container.textContent).not.toContain("Send request");
  });
});
