// @vitest-environment jsdom

import { RouterContextProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadStudioPageRenderer } from "../../../client/src/extensions.js";
import { createStudioRouter } from "../../../client/src/router.js";
import {
  ACTIONS_DOCUMENTATION_PAGE_KIND,
  type DocumentedAction,
  type StudioActionCatalog,
  type StudioActionResult,
} from "../contract.js";

const dataPath = "/studio/api/actions";
const executionPath = `${dataPath}/execute`;
const action: DocumentedAction = {
  name: "reports.daily.export",
  description: "Export daily reports.",
  middleware: ["audit"],
  execution: {
    enabled: true,
    inputSchema: { type: "object" },
    noInput: false,
    examples: [{ name: "Latest", input: { day: "today" } }, { name: "Previous", input: { day: "yesterday" } }],
  },
};
const noInputAction: DocumentedAction = {
  name: "refresh",
  middleware: [],
  execution: { enabled: true, noInput: true, inputSchema: true, examples: [] },
};
const disabledAction: DocumentedAction = {
  name: "reports.daily.delete",
  middleware: [],
  execution: { enabled: false, reason: "This action is disabled here." },
};

function catalog(actions: readonly DocumentedAction[], observability?: { dataPath: string }): Response {
  return Response.json({
    actions, executionPath, ...(observability === undefined ? {} : { observability }),
  } satisfies StudioActionCatalog);
}

function result(payload: StudioActionResult): Response {
  return Response.json(payload);
}

describe("Studio action explorer interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let request: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  async function render(endpoint: `/${string}` = dataPath) {
    const renderer = await loadStudioPageRenderer(ACTIONS_DOCUMENTATION_PAGE_KIND);
    expect(renderer).toBeDefined();
    const { router } = createStudioRouter({ basePath: "/studio", icons: {}, extensions: [] });
    await act(async () => root.render(
      <RouterContextProvider router={router}>
        {renderer!.render({
          id: "actions", kind: ACTIONS_DOCUMENTATION_PAGE_KIND, path: "/actions", title: "Actions", dataPath: endpoint,
        })}
      </RouterContextProvider>,
    ));
  }

  function button(text: string): HTMLButtonElement {
    const element = [...container.querySelectorAll("button")].find((entry) => entry.textContent.trim() === text);
    if (element === undefined) throw new Error(`Missing button: ${text}`);
    return element;
  }

  async function editPayload(value: string) {
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      // Trigger React's change event without updating its value tracker first.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("retires the old action controls while a new catalog endpoint is loading", async () => {
    const nextCatalog = Promise.withResolvers<Response>();
    request.mockResolvedValueOnce(catalog([action])).mockReturnValueOnce(nextCatalog.promise);
    await render();
    expect(button("Run action").disabled).toBe(false);

    await render("/studio/api/other-actions");
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(container.textContent).toContain("Loading action contracts");
    expect(container.textContent).not.toContain("Run action");
    await act(async () => nextCatalog.resolve(catalog([])));
    expect(container.textContent).toContain("No action is registered");
  });

  it("does not surface an aborted catalog load as an error", async () => {
    request.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })).mockResolvedValueOnce(catalog([noInputAction]));
    await render();
    await render("/studio/api/other-actions");
    expect(container.textContent).toContain("This action takes no input.");
    expect(container.textContent).not.toContain("Aborted");
  });

  it("expands namespaces, switches documentation, and shows executable contracts", async () => {
    request.mockResolvedValueOnce(catalog([action, disabledAction, { name: "guide", middleware: [] }]));
    await render();
    expect(container.textContent).toContain("Export daily reports.");
    expect(container.textContent).toContain("audit");
    expect(container.querySelectorAll(".action-tree details[open]")).toHaveLength(2);

    await act(async () => button("Collapse all").click());
    expect(container.querySelectorAll(".action-tree details[open]")).toHaveLength(0);
    await act(async () => button("Expand all").click());
    const outer = container.querySelector<HTMLElement>(".action-tree summary")!;
    await act(async () => outer.click());
    expect(outer.parentElement?.hasAttribute("open")).toBe(false);
    await act(async () => outer.click());
    expect(outer.parentElement?.hasAttribute("open")).toBe(true);
    await act(async () => button("delete").click());
    expect(button("delete").getAttribute("aria-current")).toBe("true");
    expect(container.textContent).toContain("This action is disabled here.");
    expect(container.textContent).toContain("No description provided.");
    await act(async () => button("guide").click());
    expect(container.textContent).toContain("This action is available for documentation only.");
  });

  it("validates input, locks the running action, and retries after a structured validation failure", async () => {
    const pending = Promise.withResolvers<Response>();
    request.mockResolvedValueOnce(catalog([action, noInputAction]))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(result({
        outcome: "success", executionId: "run-2", durationMs: 2,
        result: { available: true, value: { rows: 3 } },
      }));
    await render();
    expect(container.querySelector("textarea")?.value).toContain('"today"');
    await editPayload("{");
    await act(async () => button("Run action").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Enter valid JSON");
    expect(request).toHaveBeenCalledTimes(1);

    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("textarea")?.value).toContain('"yesterday"');
    await act(async () => {
      const run = button("Run action");
      run.click();
      run.click();
    });
    expect(button("Running…").disabled).toBe(true);
    expect(button("refresh").disabled).toBe(true);
    expect(select.disabled).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(executionPath, expect.objectContaining({
      method: "POST", body: JSON.stringify({ name: action.name, input: { day: "yesterday" } }),
    }));
    await act(async () => pending.resolve(result({
      outcome: "failure", executionId: "run-1", durationMs: 1,
      message: "Invalid report date", issues: [{ path: [], message: "Invalid interval" }],
    })));
    expect(container.textContent).toContain("(root): Invalid interval");
    expect(button("refresh").disabled).toBe(false);
    expect(container.querySelector("textarea")?.value).toContain('"yesterday"');

    await act(async () => button("Run action").click());
    expect(container.querySelector(".action-result")?.textContent).toContain("Succeeded");
    expect(container.querySelector(".action-result pre")?.textContent).toContain('"rows": 3');
  });

  it("reports response failures without automatically repeating a no-input action", async () => {
    request.mockResolvedValueOnce(catalog([noInputAction], { dataPath: "/studio/api/observations" }))
      .mockResolvedValueOnce(Response.json({ message: "Not authorized" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({}, { status: 502 }))
      .mockRejectedValueOnce(new Error("Network lost"))
      .mockResolvedValueOnce(result({ outcome: "failure", executionId: "run-3", durationMs: 3, message: "Unavailable" }))
      .mockResolvedValue(Response.json({ observations: [], logs: [] }));
    await render();
    expect(container.textContent).toContain("This action takes no input.");
    expect(container.querySelector("textarea")).toBeNull();
    await act(async () => button("Run action").click());
    expect(container.textContent).toContain("Not authorized");
    expect(request).toHaveBeenLastCalledWith(executionPath, expect.objectContaining({
      method: "POST", body: JSON.stringify({ name: noInputAction.name, input: null }),
    }));
    await act(async () => button("Run action").click());
    expect(container.textContent).toContain("Action request failed (502)");
    await act(async () => button("Run action").click());
    expect(container.textContent).toContain("The action may have run");
    expect(request.mock.calls.filter(([url]) => url === executionPath)).toHaveLength(3);
    await act(async () => button("Run action").click());
    expect(container.querySelector(".action-result")?.textContent).toContain("Unavailable");
    expect(container.querySelector(".action-observations")).not.toBeNull();
  });

  it.each([
    [new Response(null, { status: 503 }), "Actions request failed with status 503."],
    ["load failure", "Unable to load actions."],
  ])("renders catalog errors without a runnable action", async (response, message) => {
    if (response instanceof Response) request.mockResolvedValueOnce(response);
    else request.mockRejectedValueOnce(response);
    await render();
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain("Run action");
  });
});
