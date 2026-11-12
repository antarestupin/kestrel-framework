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
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  async function mount(path: string, detailRoute: `/${string}` = "/workers/$workerId", endpoint: `/${string}` | null = dataPath) {
    const endpointProperties = endpoint === null ? {} : { dataPath: endpoint };
    const { router, RouterProvider } = createStudioRouter({
      basePath: "/studio", icons: {},
      extensions: [{
        id: "workers", title: "Workers", section: { id: "operations", title: "Operations" },
        pages: [
          { id: "workers", kind: WORKERS_STUDIO_PAGE_KIND, path: "/workers", title: "Workers", ...endpointProperties },
          { id: "worker", kind: WORKER_STUDIO_PAGE_KIND, path: detailRoute, title: "Worker", ...endpointProperties, showInNavigation: false },
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

  it("reports an incomplete worker link without querying an unspecified queue", async () => {
    await mount("/worker", "/worker");
    expect(container.textContent).toContain("The worker link is incomplete.");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["/workers", "The workers page has no data endpoint."],
    ["/workers/reports", "The worker link is incomplete."],
  ] as const)("reports a missing data endpoint at %s without fetching", async (path, message) => {
    await mount(path, "/workers/$workerId", null);
    expect(container.querySelector(".error-panel")?.textContent).toBe(message);
    expect(request).not.toHaveBeenCalled();
  });

  it("withdraws the previous publisher while loading another worker", async () => {
    const next = Promise.withResolvers<Response>();
    request.mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(detail(firstWorker))
      .mockReturnValueOnce(next.promise);
    const router = await mount("/workers");
    expect(container.textContent).toContain("Operations workers");
    expect(container.querySelector(".worker-group-row")?.textContent).toBe("Operations workers");
    expect(container.textContent).toContain("2 registered queues");

    const link = [...container.querySelectorAll<HTMLAnchorElement>(".worker-identity")]
      .find((element) => element.textContent.includes(firstWorker.name))!;
    expect(link.getAttribute("href")).toBe("/studio/workers/reports%2Fexport");
    expect(link.style.getPropertyValue("--worker-depth")).toBe("1");
    expect(link.querySelector("small")?.textContent).toBe(firstWorker.description);
    expect(link.parentElement?.querySelector(":scope > strong")?.textContent).toBe("5");
    expect(button("Active").querySelector("svg")).not.toBeNull();
    expect(button("Active").classList.contains("enabled")).toBe(true);
    expect(button("Paused").querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll(".worker-identity small")).toHaveLength(1);
    await act(async () => link.click());
    expect(request).toHaveBeenLastCalledWith(`${dataPath}/catalog/reports%2Fexport`, {
      headers: { accept: "application/json" }, signal: expect.any(AbortSignal),
    });
    expect(button("Enqueue job").disabled).toBe(false);
    expect(button("Enqueue job").querySelector("svg")).not.toBeNull();
    expect(button("Active").classList.contains("enabled")).toBe(true);
    expect([...container.querySelectorAll(".worker-detail-stats > span")].map(({ textContent }) => textContent))
      .toEqual(["Waiting5", "Ready2", "Scheduled3", "Running1"]);
    expect(container.querySelector(".worker-publisher header div p:last-child")?.textContent).toBe(firstWorker.description);

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
    expect(button("Enqueuing…").querySelector("svg.spinning")).not.toBeNull();
    const init = request.mock.lastCall?.[1];
    expect(request.mock.lastCall?.[0]).toBe(`${dataPath}/enqueue`);
    expect(init).toEqual(expect.objectContaining({
      method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
    }));
    expect(JSON.parse(String(init?.body))).toEqual({
      queue: "reports", payload: null, executionId: expect.any(String),
    });
    await act(async () => pending.resolve(Response.json({ message: "Invalid payload" }, { status: 422 })));
    expect(container.textContent).toContain("Invalid payload");
    expect(container.querySelector("textarea")?.value).toBe("null");
    expect(examples.value).toBe("1");
    expect(container.querySelector("textarea")?.getAttribute("spellcheck")).toBe("false");

    await act(async () => button("Enqueue job").click());
    expect(container.textContent).toContain("Unable to enqueue the worker job (503).");
    await act(async () => button("Enqueue job").click());
    expect(container.querySelector(".worker-enqueue-success")?.textContent).toContain("job-7");
    expect(container.querySelector(".worker-enqueue-error")).toBeNull();
    expect(request).toHaveBeenLastCalledWith(`${dataPath}/catalog/reports%2Fexport`, expect.anything());
    await act(async () => {
      examples.value = "0";
      examples.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector(".worker-enqueue-success")).toBeNull();
    expect(JSON.parse(container.querySelector("textarea")!.value)).toEqual({ recent: true });
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
    await act(async () => {
      const active = button("Active");
      active.click();
      active.click();
    });
    expect(request.mock.calls.filter(([url]) => url === `${dataPath}/queues/control`)).toHaveLength(1);
    expect(button("Updating…").disabled).toBe(true);
    expect(button("Updating…").querySelector("svg.spinning")).not.toBeNull();
    expect(request).toHaveBeenLastCalledWith(`${dataPath}/queues/control`, expect.objectContaining({
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ queue: "reports", enabled: false }),
    }));
    await act(async () => pending.resolve(new Response(null, { status: 204 })));
    expect(container.querySelectorAll(".queue-toggle.paused")).toHaveLength(2);
  });

  it.each(["catalog", "detail"] as const)(
    "keeps current worker data when a pre-control %s poll finishes late",
    async (view) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const stale = Promise.withResolvers<Response>();
      const oldValue = () => view === "catalog" ? Response.json(catalog) : detail(firstWorker);
      const paused = { ...firstWorker, enabled: false };
      const updated = view === "catalog" ? Response.json({ nodes: [paused] }) : detail(paused);
      request.mockResolvedValueOnce(oldValue()).mockReturnValueOnce(stale.promise)
        .mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(updated);
      await mount(view === "catalog" ? "/workers" : "/workers/reports%2Fexport");
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(request).toHaveBeenCalledTimes(2);
      const signal = request.mock.calls[1]?.[1]?.signal;

      await act(async () => {
        const active = button("Active");
        active.click();
        active.click();
      });
      expect(request.mock.calls.filter(([url]) => url === `${dataPath}/queues/control`)).toHaveLength(1);
      expect(container.querySelector(".queue-toggle")?.classList.contains("paused")).toBe(true);
      await act(async () => stale.resolve(oldValue()));
      expect(container.querySelector(".queue-toggle")?.classList.contains("paused")).toBe(true);
      expect(signal?.aborted).toBe(true);
      expect(request).toHaveBeenCalledTimes(4);
    },
  );

  it.each([
    ["catalog", "network"],
    ["detail", "network"],
    ["detail", "http"],
    ["detail", "body"],
  ] as const)("ignores a cancelled %s read that settles through %s after a queue update", async (view, outcome) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stale = Promise.withResolvers<Response>();
    const body = Promise.withResolvers<StudioWorkerDetail>();
    const oldResponse = () => view === "catalog" ? Response.json(catalog) : detail(firstWorker);
    const paused = { ...firstWorker, enabled: false };
    const currentResponse = () => view === "catalog" ? Response.json({ nodes: [paused] }) : detail(paused);
    const bodyResponse = new Response();
    const readJson = vi.spyOn(bodyResponse, "json").mockReturnValue(body.promise);
    request.mockResolvedValueOnce(oldResponse())
      .mockReturnValueOnce(outcome === "body" ? Promise.resolve(bodyResponse) : stale.promise)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(currentResponse());
    await mount(view === "catalog" ? "/workers" : "/workers/reports%2Fexport");
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    if (outcome === "body") expect(readJson).toHaveBeenCalledOnce();
    await act(async () => button("Active").click());
    await act(async () => {
      if (outcome === "network") stale.reject(new Error("Abandoned queue read"));
      if (outcome === "http") stale.resolve(new Response(null, { status: 503 }));
      if (outcome === "body") body.resolve({ worker: firstWorker });
    });
    expect(button("Paused").classList.contains("paused")).toBe(true);
    expect(container.querySelector(".error-panel")).toBeNull();
  });

  it("keeps independent queue toggles disabled until their own updates settle", async () => {
    const pause = Promise.withResolvers<Response>();
    const resume = Promise.withResolvers<Response>();
    const refreshedCatalog = (first: StudioWorkerQueue, second: StudioWorkerQueue) => Response.json({
      nodes: [{ kind: "group", id: "operations", name: "Operations workers", children: [first, second] }],
    } satisfies StudioWorkerCatalog);
    request.mockResolvedValueOnce(Response.json(catalog))
      .mockReturnValueOnce(pause.promise)
      .mockReturnValueOnce(resume.promise)
      .mockResolvedValueOnce(refreshedCatalog(firstWorker, { ...secondWorker, enabled: true }))
      .mockResolvedValueOnce(refreshedCatalog({ ...firstWorker, enabled: false }, { ...secondWorker, enabled: true }));
    await mount("/workers");

    const [first, second] = container.querySelectorAll<HTMLButtonElement>(".queue-toggle");
    await act(async () => first!.click());
    expect(first?.disabled).toBe(true);
    await act(async () => second!.click());
    expect(first?.disabled).toBe(true);
    expect(second?.disabled).toBe(true);
    await act(async () => resume.resolve(new Response(null, { status: 204 })));
    expect(first?.disabled).toBe(true);
    expect(second?.disabled).toBe(false);
    await act(async () => pause.resolve(new Response(null, { status: 204 })));
    expect(first?.disabled).toBe(false);
  });

  it("reports a failed queue update and reloads the catalog on retry", async () => {
    request.mockRejectedValueOnce("Worker network unavailable")
      .mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(Response.json(catalog))
      .mockRejectedValueOnce("Queue network unavailable")
      .mockResolvedValueOnce(Response.json({ nodes: [] }));
    await mount("/workers");
    expect(container.textContent).toContain("Worker network unavailable");
    await act(async () => button("Retry").click());
    await act(async () => button("Active").click());
    expect(container.textContent).toContain("Unable to update the queue (403).");
    await act(async () => button("Retry").click());
    await act(async () => button("Active").click());
    expect(container.textContent).toContain("Queue network unavailable");
    await act(async () => button("Retry").click());
    expect(container.textContent).toContain("0 registered queues");
  });

  it("manually refreshes the queue counters without polling", async () => {
    request.mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(Response.json({ nodes: [{ ...firstWorker, ready: 4, scheduled: 1, reserved: 7 }] }));
    await mount("/workers");
    await act(async () => button("Refresh").click());
    expect(request.mock.calls.map(([url]) => url)).toEqual([`${dataPath}/catalog`, `${dataPath}/catalog`]);
    const queue = container.querySelector(".worker-identity")?.parentElement;
    expect([...queue!.querySelectorAll(":scope > strong, :scope > span")].map(({ textContent }) => textContent))
      .toEqual(["5", "4", "1", "7"]);
  });

  it("retries a detail failure, refreshes metrics, and recovers after a rejected queue control", async () => {
    const refreshed = Promise.withResolvers<Response>();
    const resumed = Promise.withResolvers<Response>();
    request.mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error("Worker connection interrupted"))
      .mockRejectedValueOnce("Worker details unavailable")
      .mockResolvedValueOnce(detail(secondWorker))
      .mockReturnValueOnce(refreshed.promise)
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockRejectedValueOnce("Queue control unavailable")
      .mockReturnValueOnce(resumed.promise)
      .mockResolvedValueOnce(detail({ ...secondWorker, enabled: true }));
    await mount("/workers/messages");
    expect(container.textContent).toContain("Unable to load the worker (503).");
    await act(async () => button("Retry").click());
    expect(container.textContent).toContain("Worker connection interrupted");
    await act(async () => button("Retry").click());
    expect(container.textContent).toContain("Worker details unavailable");
    await act(async () => button("Retry").click());
    expect(button("Paused").disabled).toBe(false);
    expect(button("Paused").querySelector("svg")).not.toBeNull();
    expect(button("Refresh").querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".worker-example-picker")).toBeNull();
    expect(container.querySelector(".worker-publisher header div p:not(.eyebrow)")).toBeNull();
    await act(async () => button("Refresh").click());
    expect(button("Refreshing…").disabled).toBe(true);
    expect(button("Refreshing…").querySelector("svg.spinning")).not.toBeNull();
    await act(async () => refreshed.resolve(detail({ ...secondWorker, ready: 9 })));
    expect(button("Refresh").disabled).toBe(false);

    await act(async () => button("Paused").click());
    expect(container.querySelector(".worker-control-error")?.textContent).toContain("Unable to update the queue (403).");
    await act(async () => button("Paused").click());
    expect(container.querySelector(".worker-control-error")?.textContent).toContain("Queue control unavailable");
    await act(async () => button("Paused").click());
    expect(button("Updating…").disabled).toBe(true);
    expect(button("Updating…").querySelector("svg.spinning")).not.toBeNull();
    expect(request).toHaveBeenLastCalledWith(`${dataPath}/queues/control`, expect.objectContaining({
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ queue: "messages", enabled: true }),
    }));
    await act(async () => resumed.resolve(new Response(null, { status: 204 })));
    expect(button("Active").disabled).toBe(false);
    expect(button("Active").querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".worker-control-error")).toBeNull();
  });

  it("validates the payload locally and connects a published job to its timeline", async () => {
    const enqueue = Promise.withResolvers<Response>();
    const workerDetail = { worker: secondWorker, observability: { dataPath: "/studio/observations" } } satisfies StudioWorkerDetail;
    request.mockImplementation((input) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path.endsWith("/catalog/messages")) return Promise.resolve(Response.json(workerDetail));
      if (path.endsWith("/enqueue")) return enqueue.promise;
      if (path === "/studio/observations/events") return Promise.resolve(Response.json({ items: [] }));
      throw new Error(`Unexpected request ${path}`);
    });
    await mount("/workers/messages");
    const textarea = container.querySelector("textarea")!;
    expect(textarea.value).toBe("{}");
    const edit = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => edit("{"));
    await act(async () => button("Enqueue job").click());
    expect(container.querySelector(".worker-enqueue-error")).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => edit('{"limit": 3}'));
    await act(async () => {
      const submit = button("Enqueue job");
      submit.click();
      submit.click();
    });
    expect(request.mock.calls.filter(([input]) => String(input).endsWith("/enqueue"))).toHaveLength(1);
    expect(container.querySelector(".worker-observations")).not.toBeNull();
    await act(async () => enqueue.resolve(Response.json({ jobId: "job-9", executionId: "server-job-9" }, { status: 201 })));
    expect(container.querySelector(".worker-observations code")?.textContent).toBe("server-job-9");
  });

  it("retains the payload after a transport rejection", async () => {
    request.mockResolvedValueOnce(detail(firstWorker)).mockRejectedValueOnce("Job endpoint unavailable");
    await mount("/workers/reports%2Fexport");
    const input = container.querySelector("textarea")?.value;
    await act(async () => button("Enqueue job").click());
    expect(container.querySelector(".worker-enqueue-error")?.textContent).toContain("Job endpoint unavailable");
    expect(container.querySelector("textarea")?.value).toBe(input);
    expect(button("Enqueue job").disabled).toBe(false);
    const examples = container.querySelector("select")!;
    await act(async () => {
      examples.value = "1";
      examples.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector(".worker-enqueue-error")).toBeNull();
  });

  it("displays the HTTP failure instead of an invalid server error message", async () => {
    request.mockResolvedValueOnce(detail(firstWorker))
      .mockResolvedValueOnce(Response.json({ message: 27 }, { status: 502 }));
    await mount("/workers/reports%2Fexport");
    await act(async () => button("Enqueue job").click());
    expect(container.querySelector(".worker-enqueue-error")?.textContent).toBe("Unable to enqueue the worker job (502).");
  });

  it("does not refresh a retired queue after an enqueue response arrives", async () => {
    const enqueue = Promise.withResolvers<Response>();
    request.mockResolvedValueOnce(detail(firstWorker))
      .mockReturnValueOnce(enqueue.promise)
      .mockResolvedValueOnce(detail(secondWorker));
    const router = await mount("/workers/reports%2Fexport");
    await act(async () => button("Enqueue job").click());
    await act(async () => { await router.navigate({ to: "/workers/messages" }); });
    await act(async () => enqueue.resolve(Response.json({ jobId: "job-8", executionId: "job-8" }, { status: 201 })));
    expect(container.querySelector(".worker-publisher h2")?.textContent).toBe(secondWorker.name);
    expect(container.querySelector(".worker-enqueue-success")).toBeNull();
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      `${dataPath}/catalog/reports%2Fexport`, `${dataPath}/enqueue`, `${dataPath}/catalog/messages`,
    ]);
  });

  it("clears the previous job and correlation when editing or retrying the publisher", async () => {
    const secondJob = Promise.withResolvers<Response>();
    const workerDetail = { worker: firstWorker, observability: { dataPath: "/studio/observations" } } satisfies StudioWorkerDetail;
    let attempts = 0;
    request.mockImplementation(async (input) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.startsWith("/studio/observations/")) return Response.json({ items: [] });
      if (url.pathname.endsWith("/catalog/reports%2Fexport")) return Response.json(workerDetail);
      expect(url.pathname).toBe(`${dataPath}/enqueue`);
      attempts++;
      if (attempts === 2) return secondJob.promise;
      return Response.json({ jobId: `job-${attempts}`, executionId: `execution-${attempts}` }, { status: 201 });
    });
    await mount("/workers/reports%2Fexport");
    await act(async () => button("Enqueue job").click());
    expect(container.querySelector(".worker-observations code")?.textContent).toBe("execution-1");
    expect(container.querySelector(".worker-enqueue-success")?.textContent).toContain("job-1");

    await act(async () => button("Enqueue job").click());
    expect(container.querySelector(".worker-enqueue-success")).toBeNull();
    expect(container.querySelector(".worker-observations code")?.textContent).not.toBe("execution-1");
    await act(async () => secondJob.reject(new Error("Queue disconnected")));
    expect(container.querySelector(".worker-enqueue-error")?.textContent).toBe("Queue disconnected");
    expect(container.querySelector(".worker-observations")).toBeNull();

    await act(async () => button("Enqueue job").click());
    expect(container.querySelector(".worker-observations code")?.textContent).toBe("execution-3");
    const examples = container.querySelector("select")!;
    await act(async () => {
      examples.value = "1";
      examples.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector(".worker-enqueue-success")).toBeNull();
    expect(container.querySelector(".worker-observations")).toBeNull();

    await act(async () => button("Enqueue job").click());
    expect(container.querySelector(".worker-observations code")?.textContent).toBe("execution-4");
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "{");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Enqueue job").click());
    expect(attempts).toBe(4);
    expect(container.querySelector(".worker-enqueue-error")).not.toBeNull();
    expect(container.querySelector(".worker-observations")).toBeNull();
  });

  it("stops catalog polling and aborts the active read on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pending = Promise.withResolvers<Response>();
    request.mockResolvedValueOnce(Response.json(catalog)).mockReturnValueOnce(pending.promise);
    await mount("/workers");
    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(request).toHaveBeenCalledTimes(2);
    const signal = request.mock.lastCall?.[1]?.signal;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.reject(new Error("Retired worker request")));
  });
});
