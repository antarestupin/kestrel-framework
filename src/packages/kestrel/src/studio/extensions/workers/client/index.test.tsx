// @vitest-environment jsdom

import { createMemoryHistory } from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStudioRouter } from "../../../client/src/router.js";
import {
  type StudioWorkerCatalog,
  type StudioWorkerDetail,
  type StudioWorkerQueue,
  WORKER_STUDIO_PAGE_KIND,
  WORKERS_STUDIO_PAGE_KIND,
} from "../contract.js";

const dataPath = "/studio/api/workers";
const firstWorker: StudioWorkerQueue = {
  kind: "worker", id: "reports/export", name: "Export reports", description: "Build an export.",
  queue: "reports", enabled: true, ready: 2, scheduled: 3, reserved: 1, inputSchema: true,
  examples: [{ name: "Options", payload: { recent: true } }, { name: "Default", payload: null }],
};
const secondWorker: StudioWorkerQueue = {
  kind: "worker", id: "messages", name: "Deliver messages", queue: "messages",
  enabled: false, ready: 0, scheduled: 0, reserved: 0, inputSchema: true, examples: [],
};
const catalog: StudioWorkerCatalog = {
  nodes: [{ kind: "group", id: "operations", name: "Operations workers", children: [firstWorker, secondWorker] }],
};

function detail(worker: StudioWorkerQueue): Response {
  return Response.json({ worker } satisfies StudioWorkerDetail);
}

describe("Studio worker interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let request: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("scrollTo", vi.fn());
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

  async function mount(path: string) {
    const { router, RouterProvider } = createStudioRouter({
      basePath: "/studio", icons: {},
      extensions: [{
        id: "workers", title: "Workers", section: { id: "operations", title: "Operations" },
        pages: [
          { id: "workers", kind: WORKERS_STUDIO_PAGE_KIND, path: "/workers", title: "Workers", dataPath },
          { id: "worker", kind: WORKER_STUDIO_PAGE_KIND, path: "/workers/$workerId", title: "Worker", dataPath, showInNavigation: false },
        ],
      }],
    });
    router.update({ history: createMemoryHistory({ initialEntries: [`/studio${path}`] }) });
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
    return router;
  }

  function button(label: string, scope: ParentNode = container): HTMLButtonElement {
    const found = [...scope.querySelectorAll("button")].find((element) => element.textContent.trim() === label);
    if (found === undefined) throw new Error(`Missing button: ${label}`);
    return found;
  }

  it("withdraws the previous publisher while loading another worker", async () => {
    const next = Promise.withResolvers<Response>();
    request.mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(detail(firstWorker))
      .mockReturnValueOnce(next.promise);
    const router = await mount("/workers");
    expect(container.textContent).toContain("Operations workers");
    expect(container.textContent).toContain("2 registered queues");

    const link = [...container.querySelectorAll<HTMLAnchorElement>(".worker-identity")]
      .find((element) => element.textContent.includes(firstWorker.name))!;
    expect(link.getAttribute("href")).toBe("/studio/workers/reports%2Fexport");
    await act(async () => link.click());
    expect(request).toHaveBeenLastCalledWith(`${dataPath}/catalog/reports%2Fexport`, expect.anything());
    expect(button("Enqueue job").disabled).toBe(false);

    await act(async () => { await router.navigate({ to: "/workers/messages" }); });
    // A route change must remove the old queue's live publisher before the GET resolves.
    expect(container.textContent).toContain("Loading worker");
    expect(container.textContent).not.toContain("Enqueue job");
    await act(async () => next.resolve(new Response(null, { status: 404 })));
    expect(container.textContent).toContain("This worker is no longer registered.");
    expect(container.querySelector<HTMLAnchorElement>(".worker-detail-error a")?.getAttribute("href"))
      .toBe("/studio/workers");
  });

  it("publishes the selected null payload, retains the draft on failure, and reports success", async () => {
    const pending = Promise.withResolvers<Response>();
    request.mockResolvedValueOnce(detail(firstWorker))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(new Response("Service offline", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ jobId: "job-7", executionId: "execution-7" }, { status: 201 }))
      .mockResolvedValueOnce(detail({ ...firstWorker, ready: 3 }));
    await mount("/workers/reports%2Fexport");
    const examples = container.querySelector("select")!;
    await act(async () => {
      examples.value = "1";
      examples.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => button("Enqueue job").click());
    expect(button("Enqueuing…").disabled).toBe(true);
    const init = request.mock.lastCall?.[1];
    expect(request.mock.lastCall?.[0]).toBe(`${dataPath}/enqueue`);
    expect(JSON.parse(String(init?.body))).toEqual({
      queue: "reports", payload: null, executionId: expect.any(String),
    });
    await act(async () => pending.resolve(Response.json({ message: "Invalid payload" }, { status: 422 })));
    expect(container.textContent).toContain("Invalid payload");
    expect(container.querySelector("textarea")?.value).toBe("null");

    await act(async () => button("Enqueue job").click());
    expect(container.textContent).toContain("Unable to enqueue the worker job (503).");
    await act(async () => button("Enqueue job").click());
    expect(container.querySelector(".worker-enqueue-success")?.textContent).toContain("job-7");
    expect(container.querySelector(".worker-enqueue-error")).toBeNull();
    expect(request).toHaveBeenLastCalledWith(`${dataPath}/catalog/reports%2Fexport`, expect.anything());
  });

  it("retries a missing catalog response and updates the selected queue", async () => {
    const pending = Promise.withResolvers<Response>();
    request.mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(catalog))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json({ nodes: [{ ...firstWorker, enabled: false }, secondWorker] }));
    await mount("/workers");
    expect(container.textContent).toContain("Unable to load worker queues (503).");
    await act(async () => button("Retry").click());
    await act(async () => button("Active").click());
    expect(button("Updating…").disabled).toBe(true);
    expect(request).toHaveBeenLastCalledWith(`${dataPath}/queues/control`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ queue: "reports", enabled: false }),
    }));
    await act(async () => pending.resolve(new Response(null, { status: 204 })));
    expect(container.querySelectorAll(".queue-toggle.paused")).toHaveLength(2);
  });
});
