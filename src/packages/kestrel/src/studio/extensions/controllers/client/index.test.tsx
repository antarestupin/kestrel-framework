// @vitest-environment jsdom

import { RouterContextProvider } from "@tanstack/react-router";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadStudioPageRenderer } from "../../../client/src/extensions.js";
import { createStudioRouter } from "../../../client/src/router.js";
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
      vi.restoreAllMocks();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  async function render(manifest: StudioPageManifest = page, strict = false) {
    const renderer = await loadStudioPageRenderer(CONTROLLERS_STUDIO_PAGE_KIND);
    expect(renderer).toBeDefined();
    const { router } = createStudioRouter({ basePath: "/studio", icons: {}, extensions: [] });
    const content = <RouterContextProvider router={router}>{renderer!.render(manifest)}</RouterContextProvider>;
    await act(async () => root.render(strict ? <StrictMode>{content}</StrictMode> : content));
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
      .mockRejectedValueOnce("Request interrupted")
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await render();
    expect(container.textContent).toContain("Loading HTTP controllers");
    const catalogData: StudioHttpControllerCatalog = {
      nodes: [
        { id: "widgets", name: "Widgets", kind: "group", children: [controller] },
        { id: "audit", name: "Audit", kind: "group", children: [] },
      ],
    };
    await act(async () => catalog.resolve(Response.json(catalogData)));
    expect(request.mock.calls[0]).toEqual([page.dataPath, {
      headers: { accept: "application/json" }, signal: expect.any(AbortSignal),
    }]);
    expect(container.querySelector(".controller-route-heading p")?.textContent).toBe(controller.description);
    expect(container.querySelector(".controller-route-heading .method-post")?.textContent).toBe("POST");
    expect(container.querySelector(".controller-tree .method-post")?.textContent).toBe("POST");
    expect(button("Update widget").classList.contains("selected")).toBe(true);
    expect(container.querySelector(".controller-fields label small")?.textContent).toBe("path · required");
    expect(container.querySelectorAll(".controller-fields input")).toHaveLength(2);
    expect(container.querySelectorAll(".controller-fields label small")[1]?.textContent).toBe("query");
    expect(container.querySelector(".controller-fields input")?.getAttribute("placeholder")).toBe("string");
    expect(container.querySelectorAll(".controller-fields input")[1]?.getAttribute("placeholder")).toBe("value");
    expect(container.querySelector("textarea")?.value).toContain('"name": "Initial"');
    expect(container.querySelector("textarea")?.getAttribute("spellcheck")).toBe("false");
    expect(button("Collapse all").getAttribute("aria-label")).toBe("Collapse all namespaces");
    expect(button("Send request").querySelector(".kestrel-icon")).not.toBeNull();
    await act(async () => button("Collapse all").click());
    expect(button("Expand all").getAttribute("aria-label")).toBe("Expand all namespaces");
    expect(container.querySelector("details")?.open).toBe(false);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => { container.querySelector("summary")!.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
    expect(container.querySelector("details")?.open).toBe(true);
    expect(button("Expand all").getAttribute("aria-label")).toBe("Expand all namespaces");
    await act(async () => button("Expand all").click());
    expect([...container.querySelectorAll<HTMLDetailsElement>(".controller-tree details")].map(({ open }) => open))
      .toEqual([true, true]);

    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(select.value).toBe("1");
    expect(container.querySelector("textarea")?.value).toContain('"name": "Preview name"');

    const clock = vi.spyOn(performance, "now").mockReturnValue(50);
    await act(async () => button("Send request").click());
    expect(button("Sending").disabled).toBe(true);
    expect(button("Sending").querySelector(".kestrel-icon.spinning")).not.toBeNull();
    expect(request).toHaveBeenLastCalledWith("/api/widgets/two%2Fthree?mode=dry+run", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ name: "Preview name" }, null, 2),
    });
    clock.mockReturnValue(65);
    await act(async () => response.resolve(Response.json({ error: "Rejected" }, {
      status: 400,
      statusText: "Bad Request",
      headers: { "x-test": "response" },
    })));
    expect(container.querySelector(".controller-response .failure")?.textContent).toBe("400 Bad Request");
    expect(container.querySelector(".controller-response header small")?.textContent).toBe("15 ms");
    expect(container.querySelector(".controller-response")?.textContent).toContain('"error": "Rejected"');
    expect(container.querySelector(".controller-response details pre")?.textContent).toBe("content-type: application/json\nx-test: response");
    clock.mockRestore();

    await act(async () => button("Send request").click());
    expect(container.textContent).toContain("Network unavailable");
    expect(container.querySelector(".controller-response")).toBeNull();
    expect(button("Send request").disabled).toBe(false);

    await act(async () => button("Send request").click());
    expect(container.textContent).toContain("Request interrupted");

    await act(async () => button("Send request").click());
    expect(container.querySelector(".controller-response .success")?.textContent).toContain("204");
    expect(container.querySelector(".controller-response")?.textContent).toContain("(empty response)");
    expect(container.querySelector(".controller-send-row p")).toBeNull();
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

  it.each(["success", "failure"] as const)("ignores a late controller catalog %s from an aborted effect", async (outcome) => {
    const old = Promise.withResolvers<Response>();
    request.mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json({ nodes: [controller] }));
    await render(page, true);
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    await act(async () => {
      if (outcome === "success") old.resolve(Response.json({ nodes: [] }));
      else old.reject(new Error("Previous catalog unavailable"));
    });
    expect(container.querySelector(".error-panel")).toBeNull();
    expect(button("Send request").disabled).toBe(false);
    expect(container.querySelector(".controller-request-editor")?.textContent).toContain(controller.id);
  });

  it("uses the server execution ID for traces that arrive after the HTTP response", async () => {
    vi.useFakeTimers();
    const response = Promise.withResolvers<Response>();
    const observationPath = "/studio/observations";
    const second = {
      ...controller, id: "widgets.read", name: "Read widget", method: "GET", url: "/api/widgets",
      inputs: [
        { name: "search", sourceName: "search", binding: "query", required: false, schema: { format: "email" } },
        { name: "extra", sourceName: "extra", binding: "query", required: false, schema: {} },
      ],
      examples: [],
    } satisfies StudioHttpControllerDefinition;
    const catalogData: StudioHttpControllerCatalog = {
      nodes: [{ id: "widgets", name: "Widgets", kind: "group", children: [controller, second] }],
      observability: { dataPath: observationPath, executionIdHeader: "x-execution-id" },
    };
    let tracePolls = 0;
    request.mockImplementation((input) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === page.dataPath) return Promise.resolve(Response.json(catalogData));
      if (url.pathname === "/api/widgets") return response.promise;
      if (url.pathname === `${observationPath}/logs`) return Promise.resolve(Response.json({ items: [] }));
      if (url.pathname === `${observationPath}/events`) {
        const complete = url.searchParams.get("executionId") === "server-run" && ++tracePolls === 2;
        return Promise.resolve(Response.json({ items: complete ? [{
          id: "completion", sequence: 1, executionId: "server-run",
          name: "execution.completed", category: "application", occurredAt: "2026-11-12T10:00:00Z",
          schemaVersion: 1, data: {}, outcome: "success", durationMs: 5,
        }] : [] }));
      }
      throw new Error(`Unexpected request ${url}`);
    });
    await render();
    const namespace = container.querySelector<HTMLElement>(".controller-tree summary")!;
    await act(async () => namespace.click());
    expect(namespace.parentElement?.hasAttribute("open")).toBe(false);
    await act(async () => button("Expand all").click());
    await act(async () => button("Read widget").click());
    expect(button("Read widget").classList.contains("selected")).toBe(true);
    expect(button("Update widget").classList.contains("selected")).toBe(false);
    expect(container.querySelector(".controller-example-picker")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector(".controller-observations")).toBeNull();
    const input = container.querySelector("input")!;
    expect(input.placeholder).toBe("email");
    expect(container.querySelectorAll("input")[1]?.placeholder).toBe("value");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "reader@example.test");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      const send = button("Send request");
      send.click();
      send.click();
    });
    const sent = request.mock.calls.filter(([url]) => String(url).startsWith("/api/widgets"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]).toBe("/api/widgets?search=reader%40example.test");
    const requestedId = new Headers(sent[0]?.[1]?.headers).get("x-execution-id");
    expect(requestedId).toBeTruthy();
    expect(container.querySelector(".controller-observations code")?.textContent).toBe(requestedId);

    await act(async () => response.resolve(new Response("Report accepted", { headers: { "x-execution-id": "server-run" } })));
    expect(container.querySelector(".controller-observations code")?.textContent).toBe("server-run");
    expect(container.textContent).toContain("Waiting for observations");
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(container.querySelector(".controller-observations")?.textContent).toContain("execution.completed");
  });

  it("shows only the available controls and resets the response when choosing an example", async () => {
    const endpoint = {
      ...controller, description: undefined, url: "/api/commands",
      inputs: controller.inputs.filter((input) => input.binding === "body"),
    };
    // Omit the description from the serialized manifest rather than supplying null.
    request.mockResolvedValueOnce(Response.json({ nodes: [endpoint] }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await render();
    expect(container.querySelector(".controller-tree-toggle")).toBeNull();
    expect(container.querySelector(".controller-route-heading p")).toBeNull();
    expect(container.querySelector(".controller-fields")).toBeNull();
    expect(container.querySelectorAll(".controller-input-section")).toHaveLength(1);
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, '{"name":"edited"}');
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Send request").click());
    expect(request).toHaveBeenLastCalledWith("/api/commands", expect.objectContaining({ body: '{"name":"edited"}' }));
    expect(container.querySelector(".controller-response")).not.toBeNull();

    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector(".controller-response")).toBeNull();
    expect(textarea.value).toContain("Preview name");
  });

  it("retains client trace correlation when no response header was set and resets it between requests", async () => {
    const observationPath = "/studio/observations";
    const catalogData: StudioHttpControllerCatalog = {
      nodes: [controller],
      observability: { dataPath: observationPath, executionIdHeader: "x-execution-id" },
    };
    const executionIds: string[] = [];
    request.mockImplementation(async (input, init) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === page.dataPath) return Response.json(catalogData);
      if (url.pathname.startsWith(observationPath)) return Response.json({ items: [] });
      expect(url.pathname).toMatch(/^\/api\/widgets\//);
      executionIds.push(new Headers(init?.headers).get("x-execution-id")!);
      return Response.json({ ok: true });
    });
    await render();
    await act(async () => button("Send request").click());
    expect(executionIds[0]).toBeTruthy();
    expect(container.querySelector(".controller-observations code")?.textContent).toBe(executionIds[0]);

    const examples = container.querySelector("select")!;
    const choose = async (index: string) => {
      await act(async () => {
        examples.value = index;
        examples.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    await choose("1");
    expect(container.querySelector(".controller-observations")).toBeNull();
    await act(async () => button("Send request").click());
    expect(executionIds).toHaveLength(2);
    expect(executionIds[1]).not.toBe(executionIds[0]);
    expect(container.querySelector(".controller-observations code")?.textContent).toBe(executionIds[1]);
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "{");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Send request").click());
    expect(container.querySelector(".controller-send-row p")).not.toBeNull();
    expect(container.querySelector(".controller-observations")).toBeNull();
    expect(executionIds).toHaveLength(2);
    await choose("0");
    expect(container.querySelector(".controller-send-row p")).toBeNull();
  });

  it("discards an aborted catalog request and displays an empty replacement", async () => {
    request.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })).mockResolvedValueOnce(Response.json({ nodes: [] }));
    await render();
    await render({ ...page, dataPath: "/studio/empty-controllers" });
    expect(container.textContent).toContain("No HTTP controller is registered.");
    expect(container.textContent).not.toContain("Aborted");
  });

  it("renders a readable catalog error when the transport rejects with a string", async () => {
    request.mockRejectedValueOnce("Network unavailable");
    await render();
    expect(container.querySelector(".error-panel")?.textContent).toBe("Network unavailable");
  });
});
