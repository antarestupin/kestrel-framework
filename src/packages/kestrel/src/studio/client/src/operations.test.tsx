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
import type {
  StudioWorkflowCatalog,
  StudioWorkflowExecution,
  StudioWorkflowExecutionDetails,
} from "../../extensions/workflows/contract.js";
import { createStudioRouter } from "./router.js";

const workflowPath = "/studio/api/extensions/workflows";
const emailPath = "/studio/api/extensions/development-email";
const observationPath = "/studio/api/extensions/development-observations";
const timestamp = "2026-11-12T10:00:00.000Z";
const address = { address: "support@example.test", name: "Support" };
const recipient = { address: "reader@example.test", name: null };

const pages = [
  { id: "workflow-catalog", kind: "workflows.catalog", path: "/workflows", title: "Workflows", dataPath: workflowPath },
  { id: "workflow-execution", kind: "workflows.execution", path: "/workflows/$executionId", title: "Workflow execution", dataPath: workflowPath, showInNavigation: false },
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
  it("shows an unavailable version and applies search, status and definition filters to older pages", async () => {
    const catalog = {
      definitions: [{
        name: "orders.fulfill", source: { kind: "application" }, path: ["orders", "fulfill"],
        currentVersion: 2, supportedFrom: 1, signals: ["approved"],
        executions: [
          { workflowVersion: 2, status: "waiting", count: 2 },
          { workflowVersion: 2, status: "completed", count: 1 },
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
    expect(container.textContent).toContain("Unable to load durable workflow operations.");
    listUnavailable = false;
    await act(async () => button("Refresh").click());
    expect(container.textContent).toContain("orders.fulfill@3: 1 executions (version-unsupported)");
    expect(container.textContent).toContain("2 active · 3 total · 1 signals");
    expect(container.textContent).toContain("No description.");
    expect(container.querySelector('[href="/studio/workflows/child"]')?.textContent).toContain("Child");

    const search = container.querySelector<HTMLInputElement>('input[placeholder="Execution, workflow or business key"]')!;
    const [definition, status] = container.querySelectorAll<HTMLSelectElement>("select");
    await act(async () => changeValue(definition!, "orders.fulfill"));
    await act(async () => changeValue(status!, "waiting"));
    await act(async () => changeValue(search, "  order-1  "));
    await act(async () => button("Apply").click());
    expect(Object.fromEntries(requestedPages.at(-1)!)).toEqual({
      limit: "50", search: "order-1", status: "waiting", workflowName: "orders.fulfill",
    });

    await act(async () => button("Load older executions").click());
    expect(Object.fromEntries(requestedPages.at(-1)!)).toMatchObject({ cursor: "page+2", search: "order-1" });
    expect(container.querySelector('[href="/studio/workflows/older"]')?.textContent).toContain("Retry");
    expect(container.querySelector('[href="/studio/workflows/newest"]')?.textContent).toContain("Root");
    expect(container.textContent).not.toContain("Load older executions");
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
    expect(container.textContent).toContain("deadline");
    expect(container.textContent).toContain("Error: Card declined");
    expect(container.querySelector('[aria-label="Executed workflow graph"]')?.textContent).toContain("Bill customer");

    await act(async () => button("Force terminate").click());
    expect(confirm).toHaveBeenCalledOnce();
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

  it("submits the currently visible signal after polling changes the declared signals", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let signals = ["approved"];
    const delivered: unknown[] = [];
    mockFetch((url, init) => {
      if (url.pathname.endsWith("/signals")) {
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

    await act(async () => button("Deliver").click());
    expect(delivered).toEqual([{
      executionId: "current", signalName: "confirmed", payload: { operator: "member" },
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
    await act(async () => button("Deliver").click());
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

  it("retains the inbox and reports a rejected clear action before allowing a retry", async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    vi.stubGlobal("confirm", confirm);
    const original = capture("original", { subject: "Welcome", attachmentCount: 1, attachmentBytes: 1_536 });
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

    await act(async () => button("Clear inbox").click());
    expect(deletes).toBe(0);
    await act(async () => button("Clear inbox").click());
    expect(container.textContent).toContain("Unable to clear the inbox (409).");
    expect(container.textContent).toContain("Welcome");
    expect(button("Clear inbox").disabled).toBe(false);

    await act(async () => button("Clear inbox").click());
    expect(container.textContent).toContain("No emails have been captured locally.");
    expect(container.textContent).not.toContain("Unable to clear the inbox");
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
        cc: [recipient],
        bcc: [address],
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
    expect(preview.getAttribute("sandbox")).toBe("");
    expect(preview.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(preview.srcdoc).toContain("default-src 'none'");
    expect(preview.srcdoc).toContain("<p>Thanks for your order.</p>");
    expect(container.textContent).toContain("invoice.pdfUnknown type · 2.0 MB");
    expect(container.textContent).toContain("1.25 s");
    expect(container.querySelector('[href="/studio/executions/execution-log"]')?.textContent).toContain("receipt.send");

    await act(async () => button("Text").click());
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".email-preview")?.textContent).toBe("Thanks for your order.");
    await act(async () => button("HTML").click());
    expect(container.querySelector("iframe")).not.toBeNull();

    await act(async () => button("Resend").click());
    expect(resends).toBe(0);
    await act(async () => button("Resend").click());
    expect(button("Resending…").disabled).toBe(true);
    await act(async () => pendingResend.resolve(Response.json({ captureId: "copy", messageId: null })));
    expect(router.history.location.pathname).toBe("/studio/emails/copy");
    expect(container.textContent).toContain("Loading captured email…");
    expect(container.textContent).not.toContain("Original confirmation");

    await act(async () => pendingCapture.resolve(Response.json(capture("copy", {
      subject: "Copied confirmation", html: null, hasHtml: false,
    }))));
    expect(container.querySelector("h2")?.textContent).toBe("Copied confirmation");
    expect(button("HTML").disabled).toBe(true);
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
    await act(async () => button("Load older").click());
    expect(requestedCursors).toEqual([null, "10"]);
    expect(container.querySelector('[href="/studio/executions/execution-log"]')?.textContent).toContain("Unknown operation");
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
    expect([...container.querySelectorAll(".email-inbox-row")].map((row) => row.getAttribute("href"))).toEqual([
      "/studio/emails/newest", "/studio/emails/original", "/studio/emails/older",
    ]);
    expect(container.textContent).toContain("No attachments");
    expect([...container.querySelectorAll(".email-avatar")].map((avatar) => avatar.textContent)).toEqual(["R", "S", "@"]);
    expect(container.querySelector(".email-load-more")).toBeNull();

    await act(async () => button("Refresh").click());
    expect(container.textContent).not.toContain("Older message");
    expect(button("Load older")).toBeDefined();
    expect(cursors).toEqual([null, "7", null, null]);
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
});

describe("Studio observation explorer", () => {
  it.each([
    ["/execution", "The execution link is incomplete."],
    ["/correlations/workflow.id", "The correlation link is incomplete."],
    ["/correlated/execution", "The correlation link is incomplete."],
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
    await act(async () => {
      changeValue(container.querySelector<HTMLInputElement>('[placeholder="database"]')!, " database ");
      changeValue(container.querySelector<HTMLInputElement>('[placeholder="database.query"]')!, " query ");
      changeValue(container.querySelector<HTMLSelectElement>(".observation-filters select")!, "failure");
      changeValue(container.querySelector<HTMLInputElement>('[placeholder="UUID"]')!, " requested ");
    });
    await act(async () => button("Apply filters").click());
    expect(container.textContent).toContain("Current observation");
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
    expect(container.textContent).toContain("Executions request failed with status 503.");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.textContent).toContain("Unable to load observed executions.");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.textContent).toContain("No executions");
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
    expect(container.querySelector(".execution-timeline")?.textContent).toContain("run-1.event");
    expect(container.querySelector('[aria-label="Execution logs"]')?.textContent).toContain("No logs were captured.");
    await act(async () => button("Load older executions").click());
    expect(container.textContent).toContain("2 captured executions");
    const completedRow = [...container.querySelectorAll<HTMLButtonElement>(".execution-row")]
      .find((row) => row.textContent.includes("orders.complete"));
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
