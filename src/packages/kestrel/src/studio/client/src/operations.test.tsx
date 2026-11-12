// @vitest-environment jsdom

import { createMemoryHistory } from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudioPageManifest } from "../../extension.js";
import type {
  StudioEmailCaptureDetail,
  StudioEmailHistoryItem,
} from "../../extensions/email/contract.js";
import type { StudioLog } from "../../extensions/logs/contract.js";
import type { StudioObservation, StudioObservationExecution } from "../../extensions/observability/contract.js";
import "../../extensions/observability/client/index.js";
import type {
  StudioWorkflowCatalog,
  StudioWorkflowExecution,
  StudioWorkflowExecutionDetails,
} from "../../extensions/workflows/contract.js";
import "../../extensions/workflows/client/index.js";
import { createStudioRouter } from "./router.js";
import { getStudioPageRenderer } from "./page_renderer_registry.js";

const workflowPath = "/studio/api/extensions/workflows";
const emailPath = "/studio/api/extensions/development-email";
const observationPath = "/studio/api/extensions/development-observations";
const timestamp = "2026-11-12T10:00:00.000Z";
const address = { address: "support@example.test", name: "Support" };
const recipient = { address: "reader@example.test", name: null };

const pages = [
  { id: "workflow-catalog", kind: "workflows.catalog", path: "/workflows", title: "Workflows", dataPath: workflowPath },
  { id: "workflow-execution", kind: "workflows.execution", path: "/workflows/$executionId", title: "Workflow execution", dataPath: workflowPath, showInNavigation: false },
  { id: "workflow-catalog-missing", kind: "workflows.catalog", path: "/missing-workflows", title: "Workflows", showInNavigation: false },
  { id: "workflow-execution-missing", kind: "workflows.execution", path: "/missing-workflows/$executionId", title: "Workflow execution", showInNavigation: false },
  { id: "email-history", kind: "development-email-history", path: "/email-history", title: "Email history", dataPath: emailPath },
  { id: "email-inbox", kind: "development-email-inbox", path: "/emails", title: "Email inbox", dataPath: emailPath },
  { id: "email-capture", kind: "development-email-capture", path: "/emails/$captureId", title: "Captured email", dataPath: emailPath, showInNavigation: false },
  { id: "email-capture-incomplete", kind: "development-email-capture", path: "/email-capture", title: "Captured email", dataPath: emailPath, showInNavigation: false },
  { id: "observations", kind: "development-observation-list", path: "/observations", title: "Observations", dataPath: observationPath },
  { id: "executions", kind: "development-observations", path: "/executions", title: "Executions", dataPath: observationPath },
  { id: "execution", kind: "development-observation-execution", path: "/executions/$executionId", title: "Execution details", dataPath: observationPath, showInNavigation: false },
  { id: "execution-incomplete", kind: "development-observation-execution", path: "/execution", title: "Execution details", dataPath: observationPath, showInNavigation: false },
  { id: "correlation", kind: "development-observation-correlation", path: "/correlations/$contextKey/$executionId", title: "Correlated execution", dataPath: observationPath, showInNavigation: false },
  { id: "correlation-incomplete", kind: "development-observation-correlation", path: "/correlations/$contextKey", title: "Correlated execution", dataPath: observationPath, showInNavigation: false },
  { id: "correlation-without-context", kind: "development-observation-correlation", path: "/correlated/$executionId", title: "Correlated execution", dataPath: observationPath, showInNavigation: false },
  { id: "observations-without-endpoint", kind: "development-observation-list", path: "/missing-observations", title: "Observations", showInNavigation: false },
  { id: "executions-without-endpoint", kind: "development-observations", path: "/missing-executions", title: "Executions", showInNavigation: false },
  { id: "execution-without-endpoint", kind: "development-observation-execution", path: "/missing-executions/$executionId", title: "Execution details", showInNavigation: false },
  { id: "correlation-without-endpoint", kind: "development-observation-correlation", path: "/missing-correlations/$contextKey/$executionId", title: "Correlated execution", showInNavigation: false },
] as const satisfies readonly StudioPageManifest[];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollTo", vi.fn());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  // Unmount before restoring timers and fetch so page effects release owned work.
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountStudio(path: string) {
  const { router, RouterProvider } = createStudioRouter({
    basePath: "/studio",
    icons: {},
    extensions: [{
      id: "operations",
      title: "Operations",
      section: { id: "operations", title: "Operations" },
      pages,
    }],
  });
  router.update({ history: createMemoryHistory({ initialEntries: [`/studio${path}`] }) });
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}

function mockFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    handler(new URL(String(input), window.location.origin), init));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  const control = [...scope.querySelectorAll("button")].find((item) => item.textContent.trim() === label);
  expect(control, `button "${label}"`).toBeDefined();
  return control!;
}

function changeValue(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  // Use the native setter so React observes a user-style value change.
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
  field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function execution(id: string, overrides: Partial<StudioWorkflowExecution> = {}): StudioWorkflowExecution {
  return {
    executionId: id,
    workflowName: "orders.fulfill",
    workflowVersion: 2,
    historyGeneration: 3,
    status: "waiting",
    input: { orderId: "order-1" },
    rootExecutionId: id,
    cancellationRequested: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function details(value: StudioWorkflowExecution, overrides: Partial<StudioWorkflowExecutionDetails> = {}): StudioWorkflowExecutionDetails {
  return {
    execution: value,
    declaredSignals: ["approved"],
    history: [],
    archives: [],
    children: [],
    retries: [],
    waits: [],
    graph: { nodes: [], edges: [] },
    observationPath: "/executions/execution-log",
    ...overrides,
  };
}

function capture(id: string, overrides: Partial<StudioEmailCaptureDetail> = {}): StudioEmailCaptureDetail {
  return {
    id,
    sequence: 7,
    observationId: "send-observation",
    capturedAt: timestamp,
    from: address,
    to: [recipient],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "Your order",
    hasText: true,
    hasHtml: true,
    text: "Thanks for your order.",
    html: "<p>Thanks for your order.</p>",
    headers: { "x-mail-test": "preview" },
    attachmentCount: 0,
    attachmentBytes: 0,
    attachments: [],
    observation: null,
    ...overrides,
  };
}

function observation(id: string, sequence: number, overrides: Partial<StudioObservation> = {}): StudioObservation {
  return {
    id,
    sequence,
    executionId: "application-execution",
    occurredAt: timestamp,
    name: "order.updated",
    category: "application",
    schemaVersion: 1,
    outcome: "success",
    durationMs: 25,
    data: { orderId: id },
    ...overrides,
  };
}

describe("Studio workflow controls", () => {
  it("registers both workflow destinations", () => {
    const kinds = ["workflows.catalog", "workflows.execution"];
    expect(kinds.map((kind) => getStudioPageRenderer(kind)?.kind)).toEqual(kinds);
  });

  it.each([
    ["/missing-workflows", "The workflows page has no data endpoint."],
    ["/missing-workflows/current", "The workflow execution link is incomplete."],
  ] as const)("shows an error for a workflow route without a data endpoint at %s", async (path, message) => {
    const fetch = mockFetch(() => { throw new Error("Unexpected workflow request"); });
    await mountStudio(path);
    expect(container.querySelector(".error-panel")?.textContent).toBe(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows an unavailable version and applies search, status and definition filters to older pages", async () => {
    const catalog = {
      definitions: [{
        name: "orders.fulfill", source: { kind: "application" }, path: ["orders", "fulfill"],
        currentVersion: 2, supportedFrom: 1, signals: ["approved"],
        executions: [
          { workflowVersion: 2, status: "waiting", count: 2 },
          { workflowVersion: 2, status: "running", count: 1 },
          { workflowVersion: 2, status: "completed", count: 1 },
          { workflowVersion: 2, status: "cancelled", count: 1 },
          { workflowVersion: 2, status: "failed", count: 1 },
          { workflowVersion: 2, status: "terminated", count: 1 },
        ],
      }],
      unsupportedActiveVersions: [{
        workflowName: "orders.fulfill", workflowVersion: 3, count: 1, reason: "version-unsupported",
      }],
    } satisfies StudioWorkflowCatalog;
    const requestedPages: URLSearchParams[] = [];
    let listUnavailable = true;
    mockFetch((url) => {
      if (url.pathname === `${workflowPath}/catalog`) return Response.json(catalog);
      expect(url.pathname).toBe(`${workflowPath}/executions`);
      requestedPages.push(url.searchParams);
      if (listUnavailable) return new Response(null, { status: 503 });
      return url.searchParams.has("cursor")
        ? Response.json({ items: [execution("older", { retryOfExecutionId: "previous" })] })
        : Response.json({ items: [execution("newest"), execution("child", { parentExecutionId: "newest" })], nextCursor: "page+2" });
    });

    await mountStudio("/workflows");
    expect(Object.fromEntries(requestedPages[0]!)).toEqual({ limit: "50" });
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Execution, workflow or business key"]')?.value).toBe("");
    expect(container.textContent).toContain("Unable to load durable workflow operations.");
    listUnavailable = false;
    await act(async () => button("Refresh").click());
    expect(container.textContent).toContain("orders.fulfill@3: 1 executions (version-unsupported)");
    expect(container.textContent).toContain("3 active · 7 total · 1 signals");
    expect(container.textContent).toContain("No description.");
    expect(container.querySelector('[href="/studio/workflows/child"]')?.textContent).toContain("Child");
    expect(container.querySelector('[href="/studio/workflows/newest"]')?.textContent).toContain(new Date(timestamp).toLocaleString());
    expect(container.querySelector(".workflow-execution-explorer .loading-panel")).toBeNull();
    expect(container.querySelector(".workflow-execution-explorer .error-panel")).toBeNull();

    const search = container.querySelector<HTMLInputElement>('input[placeholder="Execution, workflow or business key"]')!;
    const [definition, status] = container.querySelectorAll<HTMLSelectElement>("select");
    expect(definition?.value).toBe("");
    expect([...definition!.options].map(({ value }) => value)).toEqual(["", "orders.fulfill"]);
    expect(status?.value).toBe("");
    expect([...status!.options].map(({ value }) => value)).toEqual([
      "", "blocked", "cancelled", "cancelling", "completed", "failed", "pending", "queued", "running", "terminated", "waiting",
    ]);
    await act(async () => changeValue(definition!, "orders.fulfill"));
    await act(async () => changeValue(status!, "waiting"));
    await act(async () => changeValue(search, "  order-1  "));
    let prevented = false;
    await act(async () => {
      prevented = !search.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(prevented).toBe(true);
    expect(Object.fromEntries(requestedPages.at(-1)!)).toEqual({
      limit: "50", search: "order-1", status: "waiting", workflowName: "orders.fulfill",
    });

    await act(async () => button("Load older executions").click());
    expect(Object.fromEntries(requestedPages.at(-1)!)).toMatchObject({ cursor: "page+2", search: "order-1" });
    expect(container.querySelector('[href="/studio/workflows/older"]')?.textContent).toContain("Retry");
    expect(container.querySelector('[href="/studio/workflows/newest"]')?.textContent).toContain("Root");
    expect(container.textContent).not.toContain("Load older executions");
  });

  it("only shows an empty-list loading indicator while a catalog request is pending", async () => {
    const first = Promise.withResolvers<Response>();
    const refresh = Promise.withResolvers<Response>();
    let reads = 0;
    mockFetch((url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.pathname.endsWith("/catalog")) return Response.json({ definitions: [], unsupportedActiveVersions: [] });
      reads++;
      return reads === 1 ? first.promise : refresh.promise;
    });
    await mountStudio("/workflows");
    expect(button("Refresh").disabled).toBe(true);
    expect(container.querySelector(".loading-panel")?.textContent).toBe("Loading workflows…");
    await act(async () => first.resolve(Response.json({ items: [execution("loaded")] })));
    expect(button("Refresh").disabled).toBe(false);
    await act(async () => button("Refresh").click());
    expect(button("Refresh").disabled).toBe(true);
    expect(container.querySelector(".loading-panel")).toBeNull();
    expect(container.querySelector('[href="/studio/workflows/loaded"]')).not.toBeNull();
    await act(async () => refresh.resolve(Response.json({ items: [] })));
    expect(button("Refresh").disabled).toBe(false);
    expect(container.querySelector(".loading-panel")).toBeNull();
  });

  it("renders durable state, pauses an execution and reports a failed resume", async () => {
    const pendingPause = Promise.withResolvers<Response>();
    const controls: unknown[] = [];
    let paused = false;
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    mockFetch((url, init) => {
      if (url.pathname === `${workflowPath}/control`) {
        const body = JSON.parse(String(init?.body)) as { action: string };
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({ "content-type": "application/json" });
        controls.push(body);
        if (body.action === "pause") return pendingPause.promise;
        return Response.json({ message: "Resume is temporarily unavailable." }, { status: 409 });
      }
      expect(url.pathname).toBe(`${workflowPath}/executions/current`);
      return Response.json(details(execution("current", {
        parentExecutionId: "parent", retryOfExecutionId: "previous", output: { count: 1 },
        ...(paused ? { pausedAt: timestamp } : {}),
      }), {
        children: [execution("child")],
        retries: [execution("retry")],
        waits: [
          { sequence: 1, kind: "signal", target: "approved", scheduledAt: timestamp },
          { sequence: 2, kind: "timer", target: "retry", scheduledAt: timestamp, deadline: timestamp },
        ],
        archives: [{ historyGeneration: 1, workflowVersion: 1, eventCount: 4, continuedAt: timestamp }],
        history: [
          { eventIndex: 1, type: "signal-received", occurredAt: timestamp, name: "approved" },
          { eventIndex: 2, type: "command-completed", occurredAt: timestamp, kind: "activity", target: "bill", error: { name: "Error", message: "Card declined" } },
        ],
        graph: { nodes: [
          { id: "root", kind: "execution", status: "waiting", label: "Current", executionId: "current" },
          { id: "command", kind: "command", status: "failed", label: "Bill customer", sequence: 2 },
          { id: "child", kind: "execution", status: "completed", label: "Notify customer", executionId: "child" },
        ], edges: [] },
      }));
    });

    await mountStudio("/workflows/current");
    expect(container.querySelector('[href="/studio/workflows/parent"]')?.textContent).toContain("Parent");
    expect(container.textContent).toContain("Generation 1, version 1: 4 events");
    expect(container.textContent).toContain("Waiting on signal #1");
    const waits = [...container.querySelectorAll(".workflow-waits article span")];
    expect(waits.map(({ textContent }) => textContent)).toEqual([
      `since ${new Date(timestamp).toLocaleString()}`, `deadline ${new Date(timestamp).toLocaleString()}`,
    ]);
    expect(container.textContent).toContain("Error: Card declined");
    expect(container.querySelector('[aria-label="Executed workflow graph"]')?.textContent).toContain("Bill customer");
    const graph = container.querySelector('[aria-label="Executed workflow graph"]')!;
    expect([...graph.querySelectorAll(".workflow-graph-column")].map((column) =>
      [...column.querySelectorAll("article strong")].map(({ textContent }) => textContent)))
      .toEqual([["Current"], ["Bill customer"], ["Notify customer"]]);
    expect(graph.querySelector(".commands article")?.classList.contains("failed")).toBe(true);
    expect(graph.querySelector(".commands small")?.textContent).toBe("command #2");
    expect(graph.querySelector(".root small")?.textContent).toBe("execution");
    expect(graph.querySelector(".root a")?.getAttribute("href")).toBe("/studio/workflows/current");
    expect(graph.querySelector(".external a")?.getAttribute("href")).toBe("/studio/workflows/child");
    expect(graph.querySelector(".commands a")).toBeNull();
    expect(graph.querySelectorAll(".workflow-graph-arrow")).toHaveLength(2);
    expect(container.querySelector('[href="/studio/workflows/child"]')?.textContent).toContain("Child");
    expect(container.querySelector('[href="/studio/workflows/retry"]')?.textContent).toContain("Retry");
    expect(container.querySelector(".workflow-detail-grid")?.textContent).toContain('Output{\n  "count": 1\n}');
    expect(container.querySelector(".workflow-detail-grid")?.textContent).not.toContain("Error");
    expect([...container.querySelectorAll(".workflow-timeline article span")].map(({ textContent }) => textContent))
      .toEqual(["approved", "activity: bill"]);
    expect(container.querySelector(".workflow-execution-details > .error-panel")).toBeNull();
    expect(container.textContent).not.toContain("Recover replay");
    expect(container.textContent).not.toContain("Retry as new");

    await act(async () => button("Force terminate").click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith("Force termination does not execute compensation code. Terminate this execution?");
    expect(controls).toEqual([]);
    await act(async () => button("Pause").click());
    expect(button("Pause").disabled).toBe(true);
    paused = true;
    await act(async () => pendingPause.resolve(new Response(null, { status: 204 })));
    expect(button("Resume").disabled).toBe(false);
    expect(container.textContent).toContain("paused · waiting");

    await act(async () => button("Resume").click());
    expect(container.textContent).toContain("Resume is temporarily unavailable.");
    expect(button("Resume").disabled).toBe(false);
    expect(controls).toEqual([{ executionId: "current", action: "pause" }, { executionId: "current", action: "resume" }]);
  });

  it("removes old execution controls while a new execution is loading", async () => {
    const pending = Promise.withResolvers<Response>();
    mockFetch((url) => url.pathname.endsWith("/new")
      ? pending.promise
      : Response.json(details(execution("old"))));
    const router = await mountStudio("/workflows/old");
    expect(button("Force terminate").disabled).toBe(false);

    await act(async () => { await router.navigate({ to: "/workflows/new" }); });
    expect(container.textContent).toContain("Loading execution…");
    expect(container.textContent).not.toContain("Force terminate");

    await act(async () => pending.resolve(Response.json(details(execution("new", { status: "completed" })))));
    expect(container.querySelector("h2")?.textContent).toBe("new");
    expect(container.textContent).not.toContain("Force terminate");
  });

  it("keeps refreshed workflow details when a pre-control poll completes late", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const oldPoll = Promise.withResolvers<Response>();
    let reads = 0;
    let oldSignal: AbortSignal | null | undefined;
    const fetch = mockFetch((url, init) => {
      if (url.pathname.endsWith("/control")) return new Response(null, { status: 204 });
      expect(url.pathname).toBe(`${workflowPath}/executions/current`);
      reads += 1;
      if (reads === 2) {
        oldSignal = init?.signal;
        return oldPoll.promise;
      }
      return Response.json(details(execution("current", reads === 1 ? {} : { pausedAt: timestamp })));
    });
    await mountStudio("/workflows/current");
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(reads).toBe(2);

    await act(async () => button("Pause").click());
    expect(container.querySelector(".workflow-status")?.textContent).toBe("paused · waiting");
    // The transport can still resolve after abort. This response must not restore old controls.
    await act(async () => oldPoll.resolve(Response.json(details(execution("current")))));
    expect(container.querySelector(".workflow-status")?.textContent).toBe("paused · waiting");
    expect(button("Resume").disabled).toBe(false);
    expect(oldSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("skips polls while a detail read or control is pending and stops on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const read = Promise.withResolvers<Response>();
    const command = Promise.withResolvers<Response>();
    let reads = 0;
    mockFetch((url) => {
      if (url.pathname.endsWith("/control")) return command.promise;
      reads++;
      return reads === 2 ? read.promise : Response.json(details(execution("current")));
    });
    await mountStudio("/workflows/current");
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(reads).toBe(2);
    await act(async () => button("Pause").click());
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(reads).toBe(2);
    await act(async () => read.reject(new Error("Abandoned detail poll")));
    expect(container.querySelector(".workflow-execution-details > .error-panel")).toBeNull();
    await act(async () => command.resolve(new Response(null, { status: 204 })));
    expect(reads).toBe(3);
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(reads).toBe(3);
  });

  it("does not dispatch duplicate controls or redirect after the operator navigates away", async () => {
    const retry = Promise.withResolvers<Response>();
    const requests: RequestInit[] = [];
    mockFetch((url, init) => {
      if (url.pathname.endsWith("/control")) {
        requests.push(init!);
        return retry.promise;
      }
      const id = url.pathname.split("/").at(-1)!;
      return Response.json(details(execution(id, id === "failed" ? { status: "failed" } : {})));
    });
    const router = await mountStudio("/workflows/failed");

    await act(async () => {
      const control = button("Retry as new");
      control.click();
      control.click();
    });
    expect(requests).toHaveLength(1);
    expect(button("Retry as new").disabled).toBe(true);
    await act(async () => { await router.navigate({ to: "/workflows/other" }); });
    await act(async () => retry.resolve(Response.json({ execution: execution("replacement") })));
    expect(router.history.location.pathname).toBe("/studio/workflows/other");
    expect(container.querySelector("h2")?.textContent).toBe("other");
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  it("does not start another detail request when a signal to an abandoned workflow settles", async () => {
    const delivery = Promise.withResolvers<Response>();
    const reads: string[] = [];
    mockFetch((url) => {
      if (url.pathname.endsWith("/signals")) return delivery.promise;
      const id = url.pathname.split("/").at(-1)!;
      reads.push(id);
      return Response.json(details(execution(id)));
    });
    const router = await mountStudio("/workflows/first");
    await act(async () => button("Deliver").click());
    await act(async () => { await router.navigate({ to: "/workflows/second" }); });
    await act(async () => delivery.resolve(new Response(null, { status: 204 })));
    expect(reads).toEqual(["first", "second"]);
    expect(container.querySelector("h2")?.textContent).toBe("second");
    expect(container.textContent).not.toContain("Signal delivered.");
  });

  it.each(["cancelled", "completed", "failed", "terminated"] as const)(
    "hides mutable controls on a %s execution",
    async (status) => {
      const fetch = mockFetch(() => Response.json(details(execution("terminal", { status }))));
      await mountStudio("/workflows/terminal");
      expect([...container.querySelectorAll(".workflow-controls button")].map(({ textContent }) => textContent))
        .toEqual(status === "failed" ? ["Retry as new"] : []);
      expect(container.querySelector(".workflow-signal-panel")).toBeNull();
      expect(container.querySelector(".workflow-relationships")).toBeNull();
      expect(container.querySelector(".workflow-waits")).toBeNull();
      expect(container.querySelector(".workflow-graph-column.external")).toBeNull();
      expect(container.querySelectorAll(".workflow-graph-arrow")).toHaveLength(1);
      expect(container.textContent).not.toContain("Archived generations");
      expect(container.querySelector(".workflow-detail-grid")?.textContent).not.toMatch(/Output|Error/);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each(["blocked", "waiting"] as const)("only offers replay recovery for the version-blocked execution at %s", async (status) => {
    const error = status === "waiting"
      ? { name: "WorkflowExecutionVersionUnsupportedError", message: "Prior unavailable code." }
      : undefined;
    mockFetch(() => Response.json(details(execution("current", { status, ...(error === undefined ? {} : { error }) }))));
    await mountStudio("/workflows/current");
    expect([...container.querySelectorAll(".workflow-controls button")].map(({ textContent }) => textContent))
      .toEqual(["Pause", "Cancel", "Force terminate"]);
  });

  it("sends a cancellation request and clears a failed detail refresh on the next poll", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let requested = false;
    let reads = 0;
    const fetch = mockFetch((url, init) => {
      if (url.pathname.endsWith("/control")) {
        expect(init).toMatchObject({
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ executionId: "active", action: "cancel" }),
        });
        requested = true;
        return new Response(null, { status: 204 });
      }
      reads += 1;
      if (requested && reads === 2) return new Response(null, { status: 503 });
      return Response.json(details(execution("active", { status: requested ? "cancelling" : "waiting" }), {
        history: [{ eventIndex: 1, type: "cancellation-requested", occurredAt: timestamp }],
      }));
    });
    await mountStudio("/workflows/active");
    expect(container.querySelector(".workflow-timeline article span")?.textContent).toBe("");
    await act(async () => button("Cancel").click());
    expect(container.textContent).toContain("Unable to load workflow execution (503).");
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(container.querySelector(".workflow-status")?.textContent).toBe("cancelling");
    expect(container.querySelector(".workflow-execution-details > .error-panel")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("keeps loaded older executions when polling refreshes the first page", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let newest = "newest";
    const cursors: (string | null)[] = [];
    mockFetch((url) => {
      if (url.pathname.endsWith("/catalog")) return Response.json({ definitions: [], unsupportedActiveVersions: [] });
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      return cursor === null
        ? Response.json({ items: [execution(newest)], nextCursor: "older" })
        : Response.json({ items: [execution("older")], nextCursor: "tail" });
    });
    await mountStudio("/workflows");
    await act(async () => button("Load older executions").click());
    newest = "recent";
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.querySelector('[href="/studio/workflows/recent"]')).not.toBeNull();
    expect(container.querySelector('[href="/studio/workflows/older"]')).not.toBeNull();
    await act(async () => button("Load older executions").click());
    expect(cursors).toEqual([null, "older", null, "tail"]);
    expect(container.querySelectorAll('[href="/studio/workflows/older"]')).toHaveLength(1);
    await act(async () => button("Refresh").click());
    expect(container.querySelector('[href="/studio/workflows/older"]')).toBeNull();
  });

  it("submits the currently visible signal after polling changes the declared signals", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let signals = ["approved"];
    const delivered: unknown[] = [];
    mockFetch((url, init) => {
      if (url.pathname.endsWith("/signals")) {
        expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
        delivered.push(JSON.parse(String(init?.body)));
        return Response.json({});
      }
      return Response.json(details(execution("current"), { declaredSignals: signals }));
    });
    await mountStudio("/workflows/current");

    const textarea = container.querySelector("textarea")!;
    await act(async () => changeValue(textarea, "{"));
    await act(async () => button("Deliver").click());
    expect(delivered).toEqual([]);
    await act(async () => changeValue(textarea, '{"operator":"member"}'));
    signals = ["confirmed", "declined"];
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(container.querySelector("select")?.value).toBe("confirmed");

    await act(async () => changeValue(container.querySelector("select")!, "declined"));
    expect(container.querySelector("select")?.value).toBe("declined");
    await act(async () => button("Deliver").click());
    expect(delivered).toEqual([{
      executionId: "current", signalName: "declined", payload: { operator: "member" },
    }]);
    expect(container.textContent).toContain("Signal delivered.");
  });

  it("retries a failed execution and navigates to its replacement", async () => {
    let retryAttempts = 0;
    mockFetch((url, init) => {
      if (url.pathname.endsWith("/control")) {
        expect(JSON.parse(String(init?.body))).toEqual({ executionId: "failed", action: "retry" });
        retryAttempts++;
        return retryAttempts === 1
          ? new Response("Temporarily unavailable", { status: 503 })
          : Response.json({ execution: execution("replacement") });
      }
      const value = url.pathname.endsWith("/replacement")
        ? execution("replacement", { retryOfExecutionId: "failed" })
        : execution("failed", { status: "failed", error: { name: "Error", message: "Unable to bill order." } });
      return Response.json(details(value));
    });
    const router = await mountStudio("/workflows/failed");
    expect(container.textContent).not.toContain("Send signal");
    expect(container.textContent).toContain("Unable to bill order.");
    await act(async () => button("Retry as new").click());
    expect(container.textContent).toContain("Workflow control failed (503).");
    await act(async () => button("Retry as new").click());
    expect(router.history.location.pathname).toBe("/studio/workflows/replacement");
    expect(container.querySelector("h2")?.textContent).toBe("replacement");
    expect(container.querySelector('[href="/studio/workflows/failed"]')?.textContent).toContain("Retried from");
  });

  it.each(["resolves", "rejects"])("keeps the active workflow filter when an older request %s", async (settlement) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const unfiltered = Promise.withResolvers<Response>();
    let nextFilterFailure = false;
    const request = mockFetch((url) => {
      if (url.pathname.endsWith("/catalog")) return Response.json({ definitions: [], unsupportedActiveVersions: [] });
      if (url.searchParams.get("status") !== "failed") return unfiltered.promise;
      return nextFilterFailure
        ? Promise.reject("Workflow network unavailable")
        : Response.json({ items: [execution("filtered", { status: "failed" })] });
    });
    await mountStudio("/workflows");
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(request).toHaveBeenCalledTimes(2);
    const status = container.querySelectorAll("select")[1]!;
    await act(async () => changeValue(status, "failed"));
    expect(container.querySelector('[href="/studio/workflows/filtered"]')).not.toBeNull();
    await act(async () => {
      if (settlement === "resolves") unfiltered.resolve(Response.json({ items: [execution("stale")] }));
      else unfiltered.reject(new DOMException("Aborted workflow list", "AbortError"));
    });
    expect(container.querySelector('[href="/studio/workflows/stale"]')).toBeNull();
    expect(container.querySelector('[href="/studio/workflows/filtered"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Aborted workflow list");

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(request).toHaveBeenCalledTimes(6);

    nextFilterFailure = true;
    await act(async () => button("Refresh").click());
    expect(container.textContent).toContain("Workflow network unavailable");
    expect(container.querySelector('[href="/studio/workflows/filtered"]')).not.toBeNull();
  });

  it("keeps a newer filter busy after the older request is cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const previous = Promise.withResolvers<Response>();
    const filtered = Promise.withResolvers<Response>();
    const fetch = mockFetch((url) => {
      if (url.pathname.endsWith("/catalog")) return Response.json({ definitions: [], unsupportedActiveVersions: [] });
      return url.searchParams.has("status") ? filtered.promise : previous.promise;
    });
    await mountStudio("/workflows");
    await act(async () => changeValue(container.querySelectorAll("select")[1]!, "running"));
    expect(button("Refresh").disabled).toBe(true);
    await act(async () => previous.resolve(Response.json({ items: [execution("retired")] })));
    expect(button("Refresh").disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(fetch).toHaveBeenCalledTimes(4);
    await act(async () => filtered.resolve(Response.json({ items: [execution("current")] })));
    expect(button("Refresh").disabled).toBe(false);
    expect(container.querySelector('[href="/studio/workflows/current"]')).not.toBeNull();
  });

  it("submits one custom signal at a time and permits recovery after a rejected delivery", async () => {
    const delivery = Promise.withResolvers<Response>();
    const deliveries: unknown[] = [];
    mockFetch((url, init) => {
      if (url.pathname.endsWith("/signals")) {
        deliveries.push(JSON.parse(String(init?.body)));
        if (deliveries.length === 1) return delivery.promise;
        if (deliveries.length === 2) return Promise.reject("Signal network unavailable");
        return new Response(null, { status: 204 });
      }
      return Response.json(details(execution("current"), { declaredSignals: [] }));
    });
    await mountStudio("/workflows/current");
    expect(button("Deliver").disabled).toBe(true);
    expect(container.querySelector(".workflow-signal-panel small")).toBeNull();
    await act(async () => changeValue(container.querySelector<HTMLInputElement>('[placeholder="signal.name"]')!, "  "));
    expect(button("Deliver").disabled).toBe(true);
    await act(async () => changeValue(container.querySelector<HTMLInputElement>('[placeholder="signal.name"]')!, "custom.ready"));
    await act(async () => {
      const deliver = button("Deliver");
      deliver.click();
      deliver.click();
    });
    expect(deliveries).toEqual([{ executionId: "current", signalName: "custom.ready", payload: null }]);
    expect(button("Deliver").disabled).toBe(true);

    await act(async () => delivery.resolve(new Response(null, { status: 503 })));
    expect(container.textContent).toContain("Signal failed (503).");
    expect(button("Deliver").disabled).toBe(false);
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    await act(async () => { container.querySelector(".workflow-signal-panel")!.dispatchEvent(submit); });
    expect(submit.defaultPrevented).toBe(true);
    expect(container.textContent).toContain("Signal network unavailable");
    await act(async () => button("Deliver").click());
    expect(container.textContent).toContain("Signal delivered.");
  });

  it("recovers a version-blocked execution after a failed initial detail request", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubGlobal("confirm", vi.fn(() => true));
    let attempts = 0;
    let recovered = false;
    let terminated = false;
    const actions: string[] = [];
    mockFetch((url, init) => {
      if (url.pathname.endsWith("/control")) {
        const { action } = JSON.parse(String(init?.body)) as { action: string };
        actions.push(action);
        if (actions.length === 1) return Promise.reject("Control network unavailable");
        recovered = action === "recover";
        terminated = action === "terminate";
        return new Response(null, { status: 204 });
      }
      if (++attempts === 1) return new Response(null, { status: 503 });
      if (attempts === 2) return Promise.reject("Execution network unavailable");
      const state = terminated ? execution("blocked", { status: "terminated" })
        : recovered ? execution("blocked") : execution("blocked", {
          status: "blocked", error: { name: "WorkflowExecutionVersionUnsupportedError", message: "Unavailable code." },
        });
      return Response.json(details(state, {
        history: [{ eventIndex: 1, type: "cancellation-requested", occurredAt: timestamp }],
      }));
    });
    await mountStudio("/workflows/blocked");
    expect(container.textContent).toContain("Unable to load workflow execution (503).");
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(container.textContent).toContain("Execution network unavailable");
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(container.textContent).toContain("Unavailable code.");
    await act(async () => button("Recover replay").click());
    expect(container.textContent).toContain("Control network unavailable");
    await act(async () => button("Recover replay").click());
    expect(container.textContent).not.toContain("Recover replay");
    await act(async () => button("Force terminate").click());
    expect(actions).toEqual(["recover", "recover", "terminate"]);
    expect(container.querySelector(".workflow-status")?.textContent).toBe("terminated");
  });

  it("reports an incomplete workflow link without loading an unspecified execution", async () => {
    const request = mockFetch(() => { throw new Error("Unexpected workflow request"); });
    const { router, RouterProvider } = createStudioRouter({
      basePath: "/studio", icons: {}, extensions: [{
        id: "workflows", title: "Workflows", section: { id: "operations", title: "Operations" },
        pages: [{ id: "execution", kind: "workflows.execution", path: "/incomplete", title: "Workflow", dataPath: workflowPath }],
      }],
    });
    router.update({ history: createMemoryHistory({ initialEntries: ["/studio/incomplete"] }) });
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(container.textContent).toContain("The workflow execution link is incomplete.");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Studio captured email", () => {
  it("does not send a request for a capture link without an ID", async () => {
    const fetch = mockFetch(() => { throw new Error("Unexpected email request"); });
    await mountStudio("/email-capture");
    expect(container.textContent).toContain("The captured email link is incomplete.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "development-email-history", path: "/email-history", message: "The email history page has no data endpoint." },
    { kind: "development-email-inbox", path: "/emails", message: "The email inbox page has no data endpoint." },
    { kind: "development-email-capture", path: "/emails/$captureId", message: "The captured email link is incomplete." },
  ] as const)("does not fetch a missing endpoint for $kind", async ({ kind, path, message }) => {
    const fetch = mockFetch(() => { throw new Error("Unexpected email request"); });
    const { router, RouterProvider } = createStudioRouter({
      basePath: "/studio", icons: {}, extensions: [{
        id: "email", title: "Email", section: { id: "operations", title: "Operations" },
        pages: [{ id: "detail", kind, path, title: "Email" }],
      }],
    });
    router.update({ history: createMemoryHistory({ initialEntries: [`/studio${path.replace("$captureId", "original")}`] }) });
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(container.textContent).toContain(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps loaded messages visible when loading an older page fails", async () => {
    const current = capture("current", { subject: "Current message" });
    const earlier = capture("earlier", { subject: "Earlier message" });
    let attempts = 0;
    mockFetch((url) => {
      if (!url.searchParams.has("before")) return Response.json({ items: [current], nextBefore: 5 });
      attempts += 1;
      return attempts === 1 ? new Response(null, { status: 503 }) : Response.json({ items: [earlier], nextBefore: null });
    });
    await mountStudio("/emails");
    await act(async () => button("Load older").click());
    expect(container.textContent).toContain("Email request failed (503).");
    expect(container.querySelector(".email-inbox-list")?.textContent).toContain("Current message");
    await act(async () => button("Load older").click());
    expect(container.querySelector(".error-panel")).toBeNull();
    expect(container.querySelectorAll(".email-inbox-row")).toHaveLength(2);
  });

  it("retains the inbox and reports a rejected clear action before allowing a retry", async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    vi.stubGlobal("confirm", confirm);
    const original = capture("original", { subject: "Welcome", to: [recipient, address], attachmentCount: 1, attachmentBytes: 1_536 });
    let cleared = false;
    let deletes = 0;
    mockFetch((url, init) => {
      expect(url.pathname).toBe(`${emailPath}/captures`);
      if (init?.method === "DELETE") {
        deletes++;
        if (deletes === 1) return new Response(null, { status: 409 });
        cleared = true;
        return new Response(null, { status: 204 });
      }
      expect(url.searchParams.get("limit")).toBe("50");
      return Response.json({ items: cleared ? [] : [original], nextBefore: null });
    });
    await mountStudio("/emails");
    expect(container.querySelector('[href="/studio/emails/original"]')?.textContent).toContain("1 attachments · 1.5 KB");
    expect(container.querySelector(".email-inbox-content small")?.textContent).toBe("To reader@example.test, Support <support@example.test>");

    await act(async () => button("Clear inbox").click());
    expect(deletes).toBe(0);
    await act(async () => button("Clear inbox").click());
    expect(container.textContent).toContain("Unable to clear the inbox (409).");
    expect(container.textContent).toContain("Welcome");
    expect(button("Clear inbox").disabled).toBe(false);

    await act(async () => button("Clear inbox").click());
    expect(container.textContent).toContain("No emails have been captured locally.");
    expect(container.textContent).not.toContain("Unable to clear the inbox");
    expect(container.querySelector(".email-inbox-list")).toBeNull();
    expect(confirm).toHaveBeenLastCalledWith("Clear every locally captured email? This cannot be undone.");
  });

  it("cancels an in-flight clear on departure without reading the abandoned inbox again", async () => {
    vi.stubGlobal("confirm", () => true);
    const pending = Promise.withResolvers<Response>();
    const reads = vi.fn();
    let deleteSignal: AbortSignal | null | undefined;
    mockFetch((url, init) => {
      if (url.pathname.endsWith("/history")) return Response.json({ items: [], nextBefore: null });
      if (init?.method === "DELETE") {
        deleteSignal = init.signal;
        return pending.promise;
      }
      reads();
      return Response.json({ items: [capture("original")], nextBefore: null });
    });
    const router = await mountStudio("/emails");
    try {
      await act(async () => button("Clear inbox").click());
      expect(button("Clear inbox").disabled).toBe(true);
      await act(async () => { await router.navigate({ to: "/email-history" }); });
      expect(deleteSignal?.aborted).toBe(true);
      await act(async () => pending.resolve(new Response(null, { status: 204 })));
      expect(reads).toHaveBeenCalledOnce();
      expect(container.querySelector(".email-table")).toBeNull();
      expect(container.textContent).toContain("No email sends have been observed.");
    expect(container.querySelector(".email-toolbar .danger")).toBeNull();
    } finally {
      pending.resolve(new Response(null, { status: 204 }));
    }
  });

  it("renders a sandboxed preview, switches to text and resends to the new capture", async () => {
    const pendingResend = Promise.withResolvers<Response>();
    const pendingCapture = Promise.withResolvers<Response>();
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    vi.stubGlobal("confirm", confirm);
    let resends = 0;
    mockFetch((url, init) => {
      if (url.pathname === `${emailPath}/captures/copy`) return pendingCapture.promise;
      if (url.pathname.endsWith("/resend")) {
        expect(url.pathname).toBe(`${emailPath}/captures/original/resend`);
        expect(init?.method).toBe("POST");
        resends++;
        return pendingResend.promise;
      }
      expect(url.pathname).toBe(`${emailPath}/captures/original`);
      return Response.json(capture("original", {
        subject: "Original confirmation",
        to: [recipient, address], cc: [recipient, address], bcc: [address, recipient],
        attachmentCount: 1,
        attachments: [{ filename: "invoice.pdf", size: 2_097_152, contentId: "invoice", contentType: null, disposition: "attachment" }],
        observation: {
          id: "send-observation", executionId: "execution-log", occurredAt: timestamp,
          operation: "receipt.send", outcome: "success", result: "captured", transport: null, durationMs: 1_250,
        },
      }));
    });
    const router = await mountStudio("/emails/original");
    const preview = container.querySelector("iframe")!;
    expect(preview.title).toBe("HTML preview for Original confirmation");
    expect(preview.getAttribute("sandbox")).toBe("");
    expect(preview.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(preview.srcdoc).toContain("default-src 'none'");
    expect(preview.srcdoc).toContain("<p>Thanks for your order.</p>");
    expect(container.textContent).toContain("invoice.pdfUnknown type · 2.0 MB");
    expect(container.textContent).toContain("1.25 s");
    expect(container.textContent).toContain("cid:invoice");
    expect(container.querySelector(".email-observation")?.textContent).toContain("Unknown transport");
    const header = container.querySelector(".email-detail-header");
    expect([...header!.querySelectorAll("p")].slice(1).map(({ textContent }) => textContent)).toEqual([
      `To ${recipient.address}, ${address.name} <${address.address}>`,
      `Cc ${recipient.address}, ${address.name} <${address.address}>`,
      `Bcc ${address.name} <${address.address}>, ${recipient.address}`,
    ]);
    expect(container.querySelector('[href="/studio/executions/execution-log"]')?.textContent).toContain("receipt.send");
    expect(button("HTML").className).toBe("active");
    expect(button("Text").className).toBe("");

    await act(async () => button("Text").click());
    expect(container.querySelector("iframe")).toBeNull();
    expect(button("HTML").className).toBe("");
    expect(button("Text").className).toBe("active");
    expect(container.querySelector(".email-preview")?.textContent).toBe("Thanks for your order.");
    await act(async () => button("HTML").click());
    expect(container.querySelector("iframe")).not.toBeNull();

    const idleIcon = button("Resend").querySelector("svg path")?.getAttribute("d");
    expect(idleIcon).toBeTruthy();
    await act(async () => button("Resend").click());
    expect(resends).toBe(0);
    await act(async () => button("Resend").click());
    expect(button("Resending…").disabled).toBe(true);
    const busyIcon = button("Resending…").querySelector("svg path")?.getAttribute("d");
    expect(busyIcon).toBeTruthy();
    expect(busyIcon).not.toBe(idleIcon);
    expect(confirm).toHaveBeenLastCalledWith("Replay this message through the configured local email transport using its original recipients?");
    await act(async () => pendingResend.resolve(Response.json({ captureId: "copy", messageId: null })));
    expect(router.history.location.pathname).toBe("/studio/emails/copy");
    expect(container.textContent).toContain("Loading captured email…");
    expect(container.textContent).not.toContain("Original confirmation");

    await act(async () => pendingCapture.resolve(Response.json(capture("copy", {
      subject: "Copied confirmation", html: null, hasHtml: false,
    }))));
    expect(container.querySelector("h2")?.textContent).toBe("Copied confirmation");
    expect(button("HTML").disabled).toBe(true);
    expect(button("Text").classList.contains("active")).toBe(true);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelectorAll(".email-detail-header p")).toHaveLength(2);
    expect(container.textContent).toContain("No attachments.");
    expect(container.querySelector(".email-preview")?.textContent).toBe("Thanks for your order.");
    expect(container.textContent).toContain("The linked observation is pending");
  });

  it("links history to captures or their execution and appends older observations", async () => {
    const history = {
      id: "send", sequence: 10, executionId: "execution-log", occurredAt: timestamp,
      outcome: "success", durationMs: 12.3, client: "email", operation: "receipt.send",
      transport: "capture", result: "captured", recipientCount: 1, attachmentCount: 0, captureId: "original",
    } satisfies StudioEmailHistoryItem;
    const requestedCursors: Array<string | null> = [];
    mockFetch((url) => {
      expect(url.pathname).toBe(`${emailPath}/history`);
      const before = url.searchParams.get("before");
      requestedCursors.push(before);
      return before === null
        ? Response.json({ items: [history], nextBefore: 10 })
        : Response.json({ items: [{
          ...history, id: "older", captureId: null, outcome: "failure", result: null,
          durationMs: null, operation: null, transport: null, recipientCount: null,
        }], nextBefore: null });
    });
    await mountStudio("/email-history");
    expect(container.querySelector('[href="/studio/emails/original"]')?.textContent).toContain("12.3 ms");
    expect(container.querySelector('.email-result.success')?.textContent).toBe("captured");
    await act(async () => button("Load older").click());
    expect(requestedCursors).toEqual([null, "10"]);
    expect(container.querySelector('[href="/studio/executions/execution-log"]')?.textContent).toContain("Unknown operation");
    const older = container.querySelector('[href="/studio/executions/execution-log"]')!;
    const observedAt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
    expect([...older.children].slice(1).map(({ textContent }) => textContent)).toEqual(["failure", "Unknown", "—", "0", observedAt]);
    expect(older.querySelector(".email-result.failure")).not.toBeNull();
    expect(container.querySelector('[href="/studio/emails/original"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Load older");
  });

  it("shows a resend failure beside the capture and lets the operator retry immediately", async () => {
    vi.stubGlobal("confirm", () => true);
    let attempt = 0;
    const fetch = mockFetch((url) => {
      if (url.pathname.endsWith("/resend")) {
        attempt++;
        return attempt === 1
          ? new Response(null, { status: 503 })
          : Response.json({ captureId: null, messageId: "retry-delivered" });
      }
      return Response.json(capture("original", { subject: "Confirmation", text: null, hasText: false }));
    });
    const router = await mountStudio("/emails/original");
    expect(button("Text").disabled).toBe(true);
    await act(async () => button("Resend").click());
    expect(container.textContent).toContain("Unable to resend captured email (503).");
    expect(container.querySelector("h2")?.textContent).toBe("Confirmation");
    expect(button("Resend").disabled).toBe(false);

    await act(async () => button("Resend").click());
    expect(router.history.location.pathname).toBe("/studio/emails/original");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps loaded older emails when polling adds a new one and resets on manual refresh", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const older = capture("older", { subject: "Older message", from: { address: "sender@example.test", name: "" } });
    const original = capture("original", { subject: "Original message" });
    const newest = capture("newest", { subject: "Newest message", from: recipient });
    const cursors: (string | null)[] = [];
    mockFetch((url) => {
      const cursor = url.searchParams.get("before");
      cursors.push(cursor);
      if (cursor === "7") return Response.json({ items: [older], nextBefore: null });
      return Response.json({ items: cursors.length === 1 ? [original] : [newest, original], nextBefore: 7 });
    });

    await mountStudio("/emails");
    await act(async () => button("Load older").click());
    expect(container.textContent).toContain("Older message");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect([...container.querySelectorAll(".email-inbox-row")].map((row) => row.getAttribute("href"))).toEqual([
      "/studio/emails/newest", "/studio/emails/original", "/studio/emails/older",
    ]);
    expect(container.textContent).toContain("No attachments");
    expect([...container.querySelectorAll(".email-avatar")].map((avatar) => avatar.textContent)).toEqual(["R", "S", "@"]);
    expect(container.querySelector(".email-load-more")).toBeNull();

    await act(async () => button("Refresh").click());
    expect(container.textContent).not.toContain("Older message");
    expect(button("Load older")).toBeDefined();
    expect(cursors).toEqual([null, "7", null, null, null]);
  });

  it("updates the newest inbox page while an older page is loading and cancels both on departure", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const newest = capture("newest", { subject: "Newest message", attachmentCount: 1, attachmentBytes: 1_024 * 1_024 });
    const original = capture("original", { subject: "Original message", attachmentCount: 1, attachmentBytes: 1_024 });
    const older = capture("older", { subject: "Earlier message" });
    const oldPages = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
    const newestPage = Promise.withResolvers<Response>();
    let latestReads = 0;
    const olderSignals: (AbortSignal | null | undefined)[] = [];
    let latestSignal: AbortSignal | null | undefined;
    mockFetch((url, init) => {
      if (url.pathname.endsWith("/history")) return Response.json({ items: [], nextBefore: null });
      if (url.searchParams.has("before")) {
        olderSignals.push(init?.signal);
        return oldPages[olderSignals.length - 1]!.promise;
      }
      latestReads += 1;
      if (latestReads === 1) return Response.json({ items: [original], nextBefore: 10 });
      if (latestReads === 2) return Response.json({ items: [newest], nextBefore: 10 });
      latestSignal = init?.signal;
      return newestPage.promise;
    });
    const router = await mountStudio("/emails");
    try {
      expect(container.textContent).toContain("1.0 KB");
      await act(async () => button("Load older").click());
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(latestReads).toBe(2);
      expect(container.textContent).toContain("Newest message");
      expect(container.textContent).toContain("1.0 MB");
      expect(container.textContent).not.toContain("Original message");
      expect(container.querySelector(".email-empty")).toBeNull();
      await act(async () => oldPages[0]!.resolve(Response.json({ items: [newest, older], nextBefore: 5 })));
      expect(container.querySelectorAll(".email-inbox-row")).toHaveLength(2);
      expect(container.textContent).toContain("Earlier message");

      await act(async () => button("Load older").click());
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(latestReads).toBe(3);
      expect(olderSignals).toHaveLength(2);
      await act(async () => { await router.navigate({ to: "/email-history" }); });
      expect(latestSignal?.aborted).toBe(true);
      expect(olderSignals[1]?.aborted).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(4_000));
      expect(latestReads).toBe(3);
    } finally {
      const emptyPage = () => Response.json({ items: [], nextBefore: null });
      for (const page of oldPages) page.resolve(emptyPage());
      newestPage.resolve(emptyPage());
    }
  });

  it("retains the preview through polling errors and follows changes in body availability", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let reads = 0;
    mockFetch((url) => {
      expect(url.pathname).toBe(`${emailPath}/captures/original`);
      reads++;
      if (reads === 2) return new Response(null, { status: 503 });
      if (reads === 3) throw "offline";
      if (reads === 4) return Response.json(capture("original", { text: null, hasText: false }));
      if (reads === 5) return Response.json(capture("original", { text: null, html: null, hasText: false, hasHtml: false }));
      return Response.json(capture("original", {
        html: null, hasHtml: false,
        attachments: [{ filename: "note.txt", size: 42, contentId: null, contentType: "text/plain", disposition: "attachment" }],
        observation: { id: "send-observation", executionId: "execution-log", occurredAt: timestamp, operation: null, outcome: null, result: null, transport: null, durationMs: null },
      }));
    });

    await mountStudio("/emails/original");
    expect(container.querySelector(".email-preview")?.textContent).toContain("Thanks for your order");
    expect(container.textContent).toContain("text/plain · 42 B");
    expect(container.textContent).not.toContain("cid:");
    expect(container.querySelector(".email-observation")?.textContent).toContain("unknownEmail send");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.textContent).toContain("Unable to load captured email (503).");
    expect(container.querySelector(".email-preview")?.textContent).toContain("Thanks for your order");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.textContent).toContain("offline");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(button("Text").disabled).toBe(true);
    expect(container.querySelector(".error-panel")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.querySelector(".email-preview")?.textContent).toBe("No text body.");
  });

  it("preserves the selected text preview until that body becomes unavailable", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let body: Partial<StudioEmailCaptureDetail> = {};
    mockFetch(() => Response.json(capture("original", body)));
    await mountStudio("/emails/original");
    await act(async () => button("Text").click());
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(button("Text").className).toBe("active");
    expect(container.querySelector("iframe")).toBeNull();

    body = { text: null, hasText: false, html: null, hasHtml: false };
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(button("Text").className).toBe("active");
    expect(container.querySelector(".email-preview")?.textContent).toBe("No text body.");

    body = { text: null, hasText: false };
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(button("HTML").className).toBe("active");
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("shows an unavailable capture before any preview has loaded", async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    await mountStudio("/emails/missing");
    expect(container.textContent).toContain("Unable to load captured email (404).");
    expect(container.querySelector(".email-preview")).toBeNull();
  });

  it("recovers the inbox after failed loads and shows fallback errors for untyped rejections", async () => {
    vi.stubGlobal("confirm", () => true);
    let reads = 0;
    mockFetch((_url, init) => {
      if (init?.method === "DELETE") throw "unexpected delete failure";
      reads++;
      if (reads === 1) return new Response(null, { status: 403 });
      if (reads === 2) throw "offline";
      return Response.json({ items: [capture("original")], nextBefore: null });
    });
    await mountStudio("/emails");
    expect(container.textContent).toContain("Email request failed (403).");
    await act(async () => button("Refresh").click());
    expect(container.textContent).toContain("offline");
    await act(async () => button("Refresh").click());
    expect(container.textContent).toContain("Your order");
    await act(async () => button("Clear inbox").click());
    expect(container.textContent).toContain("Unable to clear the inbox.");
    expect(container.textContent).toContain("Your order");
  });

  it("keeps a capture visible when a resend rejects without an Error object", async () => {
    vi.stubGlobal("confirm", () => true);
    mockFetch((url) => {
      if (url.pathname.endsWith("/resend")) throw "offline";
      return Response.json(capture("original"));
    });
    await mountStudio("/emails/original");
    await act(async () => button("Resend").click());
    expect(container.textContent).toContain("Unable to resend captured email.");
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("dispatches one resend and keeps a later route when the response arrives after departure", async () => {
    vi.stubGlobal("confirm", () => true);
    const release = Promise.withResolvers<void>();
    const post = vi.fn();
    let resendSignal: AbortSignal | null | undefined;
    mockFetch((url, init) => {
      if (url.pathname.endsWith("/resend")) {
        post();
        resendSignal = init?.signal;
        return release.promise.then(() => Response.json({ captureId: "copy", messageId: null }));
      }
      if (url.pathname.endsWith("/history")) return Response.json({ items: [], nextBefore: null });
      return Response.json(capture("original"));
    });
    const router = await mountStudio("/emails/original");
    try {
      await act(async () => {
        const resend = button("Resend");
        resend.click();
        resend.click();
      });
      await act(async () => { await router.navigate({ to: "/email-history" }); });
      await act(async () => release.resolve());
      expect(post).toHaveBeenCalledOnce();
      expect(resendSignal?.aborted).toBe(true);
      expect(router.history.location.pathname).toBe("/studio/email-history");
    } finally {
      release.resolve();
    }
  });

  it("keeps the new capture detail when a poll started before resend arrives late", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubGlobal("confirm", () => true);
    const stale = Promise.withResolvers<Response>();
    const refreshed = Promise.withResolvers<Response>();
    let reads = 0;
    let pollSignal: AbortSignal | null | undefined;
    mockFetch((url, init) => {
      if (url.pathname.endsWith("/resend")) return Response.json({ captureId: null, messageId: "sent" });
      reads += 1;
      if (reads === 2) {
        pollSignal = init?.signal;
        return stale.promise;
      }
      if (reads === 3) return refreshed.promise;
      return Response.json(capture("original", { subject: reads === 1 ? "Original capture" : "Refreshed capture" }));
    });
    await mountStudio("/emails/original");
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      expect(reads).toBe(2);
      await act(async () => button("Resend").click());
      await act(async () => stale.resolve(Response.json(capture("original", { subject: "Stale capture" }))));
      expect(container.querySelector("h2")?.textContent).toBe("Original capture");
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(reads).toBe(3);
      await act(async () => refreshed.resolve(Response.json(capture("original", { subject: "Refreshed capture" }))));
      expect(container.querySelector("h2")?.textContent).toBe("Refreshed capture");
      expect(pollSignal?.aborted).toBe(true);
    } finally {
      stale.resolve(Response.json(capture("original")));
      refreshed.resolve(Response.json(capture("original")));
    }
  });

  it("does not restore deleted inbox entries from a poll started before clearing", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubGlobal("confirm", () => true);
    const stale = Promise.withResolvers<Response>();
    const original = capture("original");
    let reads = 0;
    let deletes = 0;
    let pollSignal: AbortSignal | null | undefined;
    mockFetch((_url, init) => {
      if (init?.method === "DELETE") {
        deletes += 1;
        return new Response(null, { status: 204 });
      }
      reads += 1;
      if (reads === 2) {
        pollSignal = init?.signal;
        return stale.promise;
      }
      return Response.json({ items: reads === 1 ? [original] : [], nextBefore: null });
    });
    await mountStudio("/emails");
    try {
      // A stalled poll should stay in flight across multiple interval ticks.
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      expect(reads).toBe(2);
      await act(async () => {
        const clear = button("Clear inbox");
        clear.click();
        clear.click();
      });
      expect(deletes).toBe(1);
      expect(container.textContent).toContain("No emails have been captured locally.");
      await act(async () => stale.resolve(Response.json({ items: [original], nextBefore: null })));
      expect(container.textContent).toContain("No emails have been captured locally.");
      expect(pollSignal?.aborted).toBe(true);
    } finally {
      stale.resolve(Response.json({ items: [], nextBefore: null }));
    }
  });

  it("refreshes email history without appending an earlier in-flight page", async () => {
    const older = Promise.withResolvers<Response>();
    const initial = { id: "initial", operation: "Initial send" };
    const current = { id: "current", operation: "Current send" };
    let olderSignal: AbortSignal | null | undefined;
    let olderReads = 0;
    let recentReads = 0;
    mockFetch((url, init) => {
      if (url.searchParams.has("before")) {
        olderReads += 1;
        olderSignal = init?.signal;
        return older.promise;
      }
      recentReads += 1;
      const item = recentReads === 1 ? initial : current;
      return Response.json({ items: [{ ...item, occurredAt: timestamp, captureId: "original" }], nextBefore: 5 });
    });
    await mountStudio("/email-history");
    try {
      await act(async () => {
        const loadMore = button("Load older");
        loadMore.click();
        loadMore.click();
      });
      await act(async () => button("Refresh").click());
      expect(olderReads).toBe(1);
      expect(olderSignal?.aborted).toBe(true);
      // A canceled older read may still settle after the newest page is visible.
      await act(async () => older.reject(new Error("Old page failed.")));
      expect(container.textContent).toContain("Current send");
      expect(container.textContent).not.toContain("Initial send");
      expect(container.textContent).not.toContain("Old page failed.");
    } finally {
      older.resolve(Response.json({ items: [], nextBefore: null }));
    }
  });
});

describe("Studio observation explorer", () => {
  it("registers a renderer for each observation destination", () => {
    const kinds = [
      "development-observations", "development-observation-list",
      "development-observation-execution", "development-observation-correlation",
    ];
    expect(kinds.map((kind) => getStudioPageRenderer(kind)?.kind)).toEqual(kinds);
  });

  it.each([
    ["/execution", "The execution link is incomplete."],
    ["/correlations/workflow.id", "The correlation link is incomplete."],
    ["/correlated/execution", "The correlation link is incomplete."],
    ["/missing-observations", "The observations page has no data endpoint."],
    ["/missing-executions", "The executions page has no data endpoint."],
    ["/missing-executions/available-id", "The execution link is incomplete."],
    ["/missing-correlations/workflow.id/available-id", "The correlation link is incomplete."],
  ])("rejects incomplete observation links at %s", async (path, message) => {
    const fetch = mockFetch(() => { throw new Error("Unexpected observation request"); });
    await mountStudio(path);
    expect(container.textContent).toContain(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("opens a dedicated execution permalink with its observations and logs", async () => {
    const fetch = mockFetch((url) => {
      expect(url.searchParams.get("executionId")).toBe("requested");
      return Response.json({ items: url.pathname.endsWith("/events") ? [
        observation("requested-event", 1, { executionId: "requested", name: "requested.observation" }),
      ] : [] });
    });
    await mountStudio("/executions/requested");
    expect(container.querySelector(".dedicated-execution")?.textContent).toContain("requested.observation");
    expect(container.querySelector('a[href="/studio/executions/requested"]')?.textContent).toBe("Permalink");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("ignores earlier filtered requests and keeps the latest observation results", async () => {
    const previous = Promise.withResolvers<Response>();
    const fetch = mockFetch((url) => {
      const category = url.searchParams.get("category");
      if (category === null) return previous.promise;
      expect(category).toBe("database");
      expect(url.searchParams.get("name")).toBe("query");
      expect(url.searchParams.get("outcome")).toBe("failure");
      expect(url.searchParams.get("executionId")).toBe("requested");
      return Response.json({ items: [observation("new", 2, { name: "Current observation" })], nextBefore: null });
    });
    await mountStudio("/observations");
    expect(container.querySelector(".loading-panel")?.textContent).toBe("Loading observations…");
    expect(container.querySelector(".error-panel")).toBeNull();
    expect(container.querySelector(".observation-list-toolbar span")?.textContent).toBe("Observations");
    await act(async () => {
      changeValue(container.querySelector<HTMLInputElement>('[placeholder="database"]')!, " database ");
      changeValue(container.querySelector<HTMLInputElement>('[placeholder="database.query"]')!, " query ");
      changeValue(container.querySelector<HTMLSelectElement>(".observation-filters select")!, "failure");
      changeValue(container.querySelector<HTMLInputElement>('[placeholder="UUID"]')!, " requested ");
    });
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    await act(async () => { container.querySelector("form")!.dispatchEvent(submit); });
    expect(submit.defaultPrevented).toBe(true);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(container.textContent).toContain("Current observation");
    expect(container.querySelector(".loading-panel")).toBeNull();
    expect(container.querySelector(".error-panel")).toBeNull();
    await act(async () => previous.resolve(Response.json({
      items: [observation("old", 1, { name: "Stale observation" })], nextBefore: null,
    })));
    expect(container.textContent).not.toContain("Stale observation");
    expect(container.textContent).toContain("Current observation");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports HTTP and untyped failures for the filtered list and its clear operation", async () => {
    let reads = 0;
    let clears = 0;
    mockFetch((_url, init) => {
      if (init?.method === "DELETE") {
        clears++;
        if (clears === 1) return new Response(null, { status: 409 });
        throw "clear failed";
      }
      reads++;
      if (reads === 1) return new Response(null, { status: 403 });
      throw "offline";
    });
    await mountStudio("/observations");
    expect(container.textContent).toContain("Observations request failed with status 403.");
    await act(async () => {
      changeValue(container.querySelector<HTMLInputElement>('[placeholder="database"]')!, "other");
    });
    await act(async () => button("Apply filters").click());
    expect(container.textContent).toContain("Unable to load observations.");
    await act(async () => button("Clear observations").click());
    expect(container.textContent).toContain("Clearing observations failed with status 409.");
    await act(async () => button("Clear observations").click());
    expect(container.textContent).toContain("Unable to clear observations.");
  });

  it("recovers the executions list through polling after HTTP and untyped failures", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let reads = 0;
    mockFetch((url) => {
      expect(url.pathname).toBe(`${observationPath}/executions`);
      reads++;
      if (reads === 1) return new Response(null, { status: 503 });
      if (reads === 2) throw "offline";
      return Response.json({ items: [], nextBefore: null });
    });
    await mountStudio("/executions");
    expect(container.querySelector(".error-panel")?.textContent).toBe("Executions request failed with status 503.");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.querySelector(".error-panel")?.textContent).toBe("Unable to load observed executions.");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.textContent).toContain("No executions");
  });

  it.each([
    ["/observations", "observations", observation("removed-event", 10, { name: "Removed observation" }), "No observations match"],
    ["/executions", "executions", {
      executionId: "removed-run", operation: "Removed execution", transport: "http", startedAt: timestamp,
      completedAt: null, outcome: null, durationMs: null,
    } satisfies StudioObservationExecution, "No executions have been observed"],
  ] as const)("ignores a pre-clear read and duplicate clear commands at %s", async (path, endpoint, item, emptyMessage) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stale = Promise.withResolvers<Response>();
    const deletion = Promise.withResolvers<Response>();
    let cleared = false;
    let reads = 0;
    let deletes = 0;
    let pollSignal: AbortSignal | null | undefined;
    mockFetch((url, init) => {
      expect(init?.headers).toEqual(init?.method === "DELETE" ? undefined : { accept: "application/json" });
      if (url.pathname.endsWith("/events") || url.pathname.endsWith("/logs")) {
        return Response.json({ items: [] });
      }
      expect(url.pathname).toBe(`${observationPath}/${endpoint}`);
      if (init?.method === "DELETE") {
        deletes++;
        return deletion.promise;
      }
      reads++;
      if (reads === 2) {
        pollSignal = init?.signal;
        return stale.promise;
      }
      return Response.json({ items: cleared ? [] : [item], nextBefore: null });
    });
    await mountStudio(path);
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      await act(async () => {
        const clear = button("Clear observations");
        clear.click();
        clear.click();
      });
      expect(deletes).toBe(1);
      expect(pollSignal?.aborted).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(reads).toBe(2);
      cleared = true;
      await act(async () => deletion.resolve(new Response(null, { status: 204 })));
      expect(container.textContent).toContain(emptyMessage);
      await act(async () => stale.resolve(Response.json({ items: [item], nextBefore: null })));
      expect(container.textContent).toContain(emptyMessage);
    } finally {
      await act(async () => {
        deletion.resolve(new Response(null, { status: 204 }));
        stale.resolve(Response.json({ items: [], nextBefore: null }));
      });
    }
  });

  it("does not duplicate observations shared by adjoining pages", async () => {
    const newest = observation("first", 10);
    const fetch = mockFetch((url) => url.searchParams.has("before")
      ? Response.json({ items: [newest, observation("second", 9)], nextBefore: null })
      : Response.json({ items: [newest], nextBefore: 10 }));
    await mountStudio("/observations");
    await act(async () => {
      const older = button("Load older observations");
      older.click();
      older.click();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("2 loaded observations");
    expect(container.textContent).not.toContain("Load older observations");
  });

  it("prioritizes operator pagination over a slow observation poll", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pending = Promise.withResolvers<Response>();
    const olderPage = Promise.withResolvers<Response>();
    const cursors: (string | null)[] = [];
    const newest = observation("current", 10);
    let pollSignal: AbortSignal | null | undefined;
    mockFetch((url, init) => {
      const cursor = url.searchParams.get("before");
      cursors.push(cursor);
      if (cursors.length === 2) {
        pollSignal = init?.signal;
        return pending.promise;
      }
      if (cursor === "10") return olderPage.promise;
      if (cursor === "5") return Response.json({ items: [observation("oldest", 4)], nextBefore: null });
      return Response.json({ items: [newest], nextBefore: 10 });
    });
    await mountStudio("/observations");
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(cursors).toEqual([null, null]);
    await act(async () => button("Load older observations").click());
    expect(pollSignal?.aborted).toBe(true);
    await act(async () => pending.reject(new Error("Abandoned observation poll")));
    expect(container.querySelector(".error-panel")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(cursors).toEqual([null, null, "10"]);
    await act(async () => olderPage.resolve(Response.json({ items: [observation("older", 9)], nextBefore: 5 })));
    expect(container.textContent).toContain("2 loaded observations");
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => button("Load older observations").click());
    expect(cursors).toEqual([null, null, "10", null, "5"]);
    expect(container.textContent).toContain("3 loaded observations");
  });

  it("replaces a first observation page without retaining history that was never loaded", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let requests = 0;
    mockFetch(() => {
      requests++;
      return Response.json({
        items: [observation(String(requests), requests, { name: requests === 1 ? "First page" : "New first page" })],
        nextBefore: null,
      });
    });
    await mountStudio("/observations");
    expect(container.querySelector(".observation-row strong")?.textContent).toBe("First page");
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.querySelector(".observation-row strong")?.textContent).toBe("New first page");
    expect(container.querySelectorAll(".observation-row")).toHaveLength(1);
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a pending observation clear when leaving the page", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const deletion = Promise.withResolvers<Response>();
    let deleteSignal: AbortSignal | null | undefined;
    const fetch = mockFetch((_url, init) => {
      if (init?.method === "DELETE") {
        deleteSignal = init.signal;
        return deletion.promise;
      }
      return Response.json({ items: [], nextBefore: null });
    });
    await mountStudio("/observations");
    await act(async () => button("Clear observations").click());
    await act(async () => root.render(null));
    expect(deleteSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => deletion.resolve(new Response(null, { status: 204 })));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reloads the filter selected while a global observation clear is pending", async () => {
    const deletion = Promise.withResolvers<Response>();
    const staleFilter = Promise.withResolvers<Response>();
    const filters: URLSearchParams[] = [];
    let deletes = 0;
    let filterSignal: AbortSignal | null | undefined;
    mockFetch((url, init) => {
      if (init?.method === "DELETE") {
        deletes++;
        return deletion.promise;
      }
      filters.push(url.searchParams);
      if (filters.length === 1) return Response.json({
        items: [observation("original", 10)], nextBefore: 10,
      });
      if (filters.length === 2) {
        filterSignal = init?.signal;
        return staleFilter.promise;
      }
      return Response.json({ items: [], nextBefore: null });
    });
    await mountStudio("/observations");
    await act(async () => button("Clear observations").click());
    await act(async () => button("Load older observations").click());
    expect(filters).toHaveLength(1);
    await act(async () => changeValue(container.querySelector<HTMLInputElement>('[placeholder="database"]')!, "database"));
    await act(async () => button("Apply filters").click());
    await act(async () => button("Clear observations").click());
    expect(deletes).toBe(1);
    await act(async () => deletion.resolve(new Response(null, { status: 204 })));
    expect(filterSignal?.aborted).toBe(true);
    expect(Object.fromEntries(filters.at(-1)!)).toEqual({ limit: "50", category: "database" });
    await act(async () => staleFilter.resolve(Response.json({
      items: [observation("stale", 9)], nextBefore: null,
    })));
    expect(container.textContent).toContain("No observations match these filters.");
  });

  it("selects a captured execution, appends older ones and handles a failed clear", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const running = {
      executionId: "run-1", operation: "orders.start", transport: "http",
      startedAt: timestamp, completedAt: null, outcome: null, durationMs: null,
    } satisfies StudioObservationExecution;
    const completed = {
      ...running,
      executionId: "run-2", operation: "orders.complete", outcome: "success",
      completedAt: timestamp, durationMs: 120,
    } satisfies StudioObservationExecution;
    let deletes = 0;
    let cleared = false;
    mockFetch((url, init) => {
      if (url.pathname.endsWith("/events")) {
        const executionId = url.searchParams.get("executionId")!;
        return Response.json({ executionId, items: [
          observation(executionId, 1, { executionId, name: `${executionId}.event` }),
        ] });
      }
      if (url.pathname.endsWith("/logs")) {
        return Response.json({ executionId: url.searchParams.get("executionId"), items: [] });
      }
      expect(url.pathname).toBe(`${observationPath}/executions`);
      if (init?.method === "DELETE") {
        deletes++;
        if (deletes === 1) return Promise.reject(new Error("Executions cannot be cleared now."));
        cleared = true;
        return new Response(null, { status: 204 });
      }
      if (cleared) return Response.json({ items: [], nextBefore: null });
      return url.searchParams.has("before")
        ? Response.json({ items: [completed], nextBefore: null })
        : Response.json({ items: [running], nextBefore: 10 });
    });
    await mountStudio("/executions");
    expect(container.querySelector(".execution-row .execution-status")?.classList.contains("running")).toBe(true);
    expect(container.querySelector(".execution-row time")?.getAttribute("datetime")).toBe(timestamp);
    expect(container.querySelector(".execution-row time")?.textContent).toBe(new Date(timestamp).toLocaleTimeString());
    expect(container.querySelector(".execution-timeline")?.textContent).toContain("run-1.event");
    expect(container.querySelector('[aria-label="Execution logs"]')?.textContent).toContain("No logs were captured.");
    await act(async () => button("Load older executions").click());
    expect(container.textContent).toContain("2 captured executions");
    const completedRow = [...container.querySelectorAll<HTMLButtonElement>(".execution-row")]
      .find((row) => row.textContent.includes("orders.complete"));
    expect(completedRow?.querySelector(".execution-status")?.classList.contains("success")).toBe(true);
    expect(completedRow?.textContent).toContain("120 ms");
    expect(container.querySelector(".load-executions-button")).toBeNull();
    await act(async () => completedRow!.click());
    expect(container.querySelector(".execution-row.selected")?.textContent).toContain("orders.complete");
    expect(container.querySelector(".execution-timeline")?.textContent).toContain("run-2.event");

    // Live refresh must retain an older execution that the operator is inspecting.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.querySelector(".execution-row.selected")?.textContent).toContain("orders.complete");
    expect(container.querySelector(".execution-timeline")?.textContent).toContain("run-2.event");

    await act(async () => button("Clear observations").click());
    expect(container.textContent).toContain("Executions cannot be cleared now.");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => button("Clear observations").click());
    expect(container.textContent).toContain("No executions have been observed yet.");
  });

  it("keeps the visible execution selected until it actually leaves the live page", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = {
      executionId: "first", operation: "First execution", transport: "http", startedAt: timestamp,
      completedAt: null, outcome: null, durationMs: null,
    } satisfies StudioObservationExecution;
    const latest = { ...first, executionId: "latest", operation: "Latest execution" };
    let reads = 0;
    const eventRequests: string[] = [];
    mockFetch((url) => {
      if (url.pathname.endsWith("/events")) {
        const executionId = url.searchParams.get("executionId")!;
        eventRequests.push(executionId);
        return Response.json({ items: [observation(executionId, 1, { name: `${executionId}.observed` })] });
      }
      if (url.pathname.endsWith("/logs")) return Response.json({ items: [] });
      reads++;
      return Response.json({
        items: reads === 1 ? [first] : reads === 2 ? [latest, first] : reads === 3 ? [] : [latest, first],
        nextBefore: null,
      });
    });
    await mountStudio("/executions");
    expect(container.querySelector(".execution-row.selected strong")?.textContent).toBe("First execution");
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.querySelector(".execution-row.selected strong")?.textContent).toBe("First execution");
    expect(eventRequests).toEqual(["first"]);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.textContent).toContain("No executions have been observed yet.");
    expect(container.querySelector(".execution-timeline")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.querySelector(".execution-row.selected strong")?.textContent).toBe("First execution");
    expect(container.querySelector(".execution-timeline")?.textContent).toContain("first.observed");
    expect(eventRequests).toEqual(["first", "first"]);
  });

  it("keeps older observations through polling and clears them after a successful retry", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const newest = observation("initial", 10);
    const older = observation("previous", 9, { outcome: "failure", durationMs: null });
    const moreRecent = observation("more-recent", 11);
    let updated = false;
    let deletes = 0;
    let cleared = false;
    const filters: URLSearchParams[] = [];
    mockFetch((url, init) => {
      expect(url.pathname).toBe(`${observationPath}/observations`);
      if (init?.method === "DELETE") {
        deletes++;
        if (deletes === 1) return Promise.reject(new Error("Observation storage is offline."));
        cleared = true;
        return new Response(null, { status: 204 });
      }
      filters.push(url.searchParams);
      if (cleared) return Response.json({ items: [], nextBefore: null });
      if (url.searchParams.has("before")) return Response.json({ items: [older], nextBefore: null });
      return Response.json({ items: updated ? [moreRecent, newest] : [newest], nextBefore: 10 });
    });
    await mountStudio("/observations");
    expect(container.textContent).toContain("1 loaded observations");
    expect(container.querySelector('[href="/studio/executions/application-execution"]')).not.toBeNull();

    const category = container.querySelector<HTMLInputElement>('input[placeholder="database"]')!;
    const name = container.querySelector<HTMLInputElement>('input[placeholder="database.query"]')!;
    const executionId = container.querySelector<HTMLInputElement>('input[placeholder="UUID"]')!;
    const outcome = container.querySelector("select")!;
    await act(async () => {
      changeValue(category, " application ");
      changeValue(name, " order.updated ");
      changeValue(executionId, " application-execution ");
      changeValue(outcome, "success");
    });
    await act(async () => button("Apply filters").click());
    expect(Object.fromEntries(filters.at(-1)!)).toEqual({
      limit: "50", category: "application", name: "order.updated", executionId: "application-execution", outcome: "success",
    });
    await act(async () => button("Reset").click());
    expect(Object.fromEntries(filters.at(-1)!)).toEqual({ limit: "50" });
    expect([category.value, name.value, executionId.value, outcome.value]).toEqual(["", "", "", ""]);

    await act(async () => button("Load older observations").click());
    expect(filters.at(-1)?.get("before")).toBe("10");
    expect(container.textContent).toContain("2 loaded observations");
    updated = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.textContent).toContain("3 loaded observations");
    expect(container.textContent).not.toContain("Load older observations");

    await act(async () => button("Clear observations").click());
    expect(container.textContent).toContain("Observation storage is offline.");
    await act(async () => button("Clear observations").click());
    expect(container.textContent).toContain("No observations match these filters.");
    expect(container.textContent).toContain("0 loaded observations");
  });

  it("groups correlated logs and observations, controls their visibility and switches to chronological view", async () => {
    const log = {
      id: 1, loggedAt: timestamp, createdAt: timestamp,
      level: 30, message: "Order persisted", requestId: "log-only-execution",
      workload: "workers", payload: {},
    } satisfies StudioLog;
    mockFetch((url) => {
      expect(Object.fromEntries(url.searchParams)).toEqual({
        executionId: "root-run", contextKey: "workflow.executionId",
      });
      if (url.pathname === `${observationPath}/events`) {
        return Response.json({ executionId: "root-run", items: [observation("initial", 1)] });
      }
      expect(url.pathname).toBe(`${observationPath}/logs`);
      return Response.json({ executionId: "root-run", items: [log] });
    });
    await mountStudio("/correlations/workflow.executionId/root-run");
    expect(button("Grouped").getAttribute("aria-pressed")).toBe("true");
    const groups = [...container.querySelectorAll<HTMLDetailsElement>(".execution-artifact-group")];
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.textContent.includes("application-execution"))?.textContent)
      .toContain("No logs.");
    expect(groups.find((group) => group.textContent.includes("log-only-execution"))?.textContent)
      .toContain("No observations.");
    const toolbar = [...container.querySelectorAll(".artifact-visibility-controls")];
    const observationSections = groups.map((group) => group.querySelector<HTMLDetailsElement>(".execution-artifact-section")!);
    expect(observationSections.every((section) => section.open)).toBe(true);
    await act(async () => button("Collapse all", toolbar[0]).click());
    expect(observationSections.every((section) => !section.open)).toBe(true);
    await act(async () => button("Expand all", toolbar[0]).click());
    expect(observationSections.every((section) => section.open)).toBe(true);
    await act(async () => button("Collapse all", toolbar[1]).click());
    expect(groups.every((group) => !group.querySelectorAll<HTMLDetailsElement>(".execution-artifact-section")[1]!.open))
      .toBe(true);

    await act(async () => button("Chronological").click());
    expect(button("Chronological").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".execution-artifact-group")).toBeNull();
    expect(container.querySelector('[aria-label="Execution logs"]')?.textContent).toContain("Order persisted");
    expect(container.querySelector(".execution-timeline")?.textContent).toContain("order.updated");
  });

  it("shows a failed logs request alongside the available correlated observations", async () => {
    mockFetch((url) => url.pathname.endsWith("/logs")
      ? new Response(null, { status: 503 })
      : Response.json({ executionId: "root-run", items: [observation("initial", 1)] }));
    await mountStudio("/correlations/workflow.executionId/root-run");
    expect(container.textContent).toContain("Execution logs request failed with status 503.");
    expect(container.querySelector(".execution-artifact-group")?.textContent).toContain("order.updated");
  });
});
