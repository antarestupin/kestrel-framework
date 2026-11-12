// @vitest-environment jsdom

import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, createContext, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExecutionDetails } from "./execution_details.js";
import type { ExecutionTimelineProperties } from "./timeline.js";

const defaults: ExecutionTimelineProperties = { dataPath: "/observations", executionId: "first" };
const ExecutionContext = createContext(defaults);
const timestamp = "2026-11-12T10:00:00.000Z";

let container: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof makeRouter>;

function makeRouter() {
  return createRouter({
    routeTree: createRootRoute({ component: () => <ExecutionDetails {...useContext(ExecutionContext)} /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollTo", vi.fn());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  router = makeRouter();
  await router.load();
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

async function renderDetails(props: Partial<ExecutionTimelineProperties> = {}) {
  await act(async () => root.render(
    <ExecutionContext.Provider value={{ ...defaults, ...props }}>
      <RouterProvider router={router} />
    </ExecutionContext.Provider>,
  ));
}

function mockRequests(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const request = vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(new URL(String(input)), init));
  vi.stubGlobal("fetch", request);
  return request;
}

const empty = () => Response.json({ items: [] });

function completed(executionId: string) {
  return Response.json({ items: [{
    id: `${executionId}-done`, sequence: 1, executionId, occurredAt: timestamp,
    name: "execution.completed", category: "execution", schemaVersion: 1,
    outcome: "success", durationMs: 20, data: { operation: "order.submit" },
  }] });
}

describe("Studio execution details polling", () => {
  it("waits for observations and logs during the request, then stops when complete or timed out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let pending = true;
    let timelineRequests = 0;
    let logRequests = 0;
    mockRequests((url) => {
      expect(url.searchParams.get("executionId")).toBe("first");
      if (url.pathname.endsWith("/logs")) {
        logRequests++;
        return empty();
      }
      timelineRequests++;
      return pending ? empty() : completed("first");
    });
    await renderDetails({ pollUntilCompleted: true, requestPending: true, pollTimeoutMs: null });
    expect(container.textContent).toContain("Waiting for observations");
    expect(container.textContent).toContain("Waiting for logs");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(timelineRequests).toBeGreaterThan(1);
    expect(logRequests).toBe(timelineRequests);
    pending = false;
    await renderDetails({ pollUntilCompleted: true, requestPending: false, pollTimeoutMs: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(container.textContent).toContain("execution.completed");
    const completedRequests = timelineRequests;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(timelineRequests).toBe(completedRequests);
    expect(container.textContent).toContain("No logs were captured.");
    const stoppedLogs = logRequests;
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(logRequests).toBe(stoppedLogs);
  });

  it("starts a fresh observation and log polling window when execution changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let nextRequests = 0;
    mockRequests((url) => {
      if (url.searchParams.get("executionId") === "second") nextRequests++;
      return empty();
    });
    await renderDetails({ pollUntilCompleted: true, pollTimeoutMs: 100 });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(container.textContent).toContain("No observations were captured.");
    expect(container.textContent).toContain("No logs were captured.");

    await renderDetails({ executionId: "second", pollUntilCompleted: true, pollTimeoutMs: 100 });
    expect(container.textContent).toContain("Waiting for observations");
    expect(container.textContent).toContain("Waiting for logs");
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(nextRequests).toBe(4);
    expect(container.textContent).toContain("No observations were captured.");
  });

  it.each([
    ["HTTP", () => new Response(null, { status: 503 }), "Timeline request failed with status 503.", "Execution logs request failed with status 503."],
    ["untyped", () => { throw "offline"; }, "Unable to load the execution timeline.", "Unable to load execution logs."],
  ] as const)("shows %s observation and log failures in chronological mode", async (_kind, reject, timelineError, logError) => {
    mockRequests(reject);
    await renderDetails();
    expect(container.querySelector(".timeline-message.error")?.textContent).toBe(timelineError);
    expect(container.querySelector(".execution-logs-message.error")?.textContent).toBe(logError);
  });

  it("distinguishes pending, failed and empty correlated artifacts while ignoring stale requests", async () => {
    const logs = Promise.withResolvers<Response>();
    const staleEvents = Promise.withResolvers<Response>();
    mockRequests((url) => {
      expect(url.searchParams.get("contextKey")).toBe("workflow.id");
      if (url.searchParams.get("executionId") === "first" && url.pathname.endsWith("/logs")) return logs.promise;
      if (url.searchParams.get("executionId") === "second") return staleEvents.promise;
      return empty();
    });
    await renderDetails({ contextKey: "workflow.id" });
    expect(container.textContent).toContain("Loading correlated artifacts");
    await act(async () => logs.resolve(new Response(null, { status: 503 })));
    expect(container.textContent).toContain("Execution logs request failed with status 503.");
    await renderDetails({ contextKey: "workflow.id", executionId: "second" });
    await renderDetails({ contextKey: "workflow.id", executionId: "third" });
    expect(container.textContent).toContain("No correlated artifacts were captured.");
    await act(async () => staleEvents.reject(new Error("Stale failure")));
    expect(container.textContent).not.toContain("Stale failure");
  });

  it("cancels scheduled polling on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const request = mockRequests(empty);
    await renderDetails({ pollUntilCompleted: true });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("aborts in-flight reads when another execution takes ownership", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const reads = mockRequests((url, init) => {
      if (url.searchParams.get("executionId") === "second") return empty();
      signals.push(init?.signal);
      // Keep the transport pending until the old execution has been retired.
      return new Promise<Response>((resolve) => {
        init?.signal?.addEventListener("abort", () => resolve(url.pathname.endsWith("/events")
          ? completed("abandoned")
          : Response.json({ items: [makeLog(99, "abandoned")] })), { once: true });
      });
    });
    await renderDetails();
    expect(reads).toHaveBeenCalledTimes(2);
    expect(signals.map((signal) => signal?.aborted)).toEqual([false, false]);
    await renderDetails({ executionId: "second" });
    expect(signals.map((signal) => signal?.aborted)).toEqual([true, true]);
    expect(container.textContent).toContain("No observations were captured.");
    expect(container.textContent).toContain("No logs were captured.");
    expect(container.textContent).not.toContain("Log 99");
    expect(container.textContent).not.toContain("execution.completed");
  });

  it("resumes interactive polling after a transient timeline or log failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const attempts = new Map<string, number>();
    mockRequests((url) => {
      const next = (attempts.get(url.pathname) ?? 0) + 1;
      attempts.set(url.pathname, next);
      if (next === 1) return new Response(null, { status: 503 });
      return url.pathname.endsWith("/events") ? completed("first") : empty();
    });
    await renderDetails({ pollUntilCompleted: true });
    expect(container.querySelector(".timeline-message.error")).not.toBeNull();
    expect(container.querySelector(".execution-logs-message.error")).not.toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(container.textContent).toContain("execution.completed");
    expect(container.querySelector(".timeline-message.error")).toBeNull();
    expect(container.textContent).toContain("Waiting for logs");
    expect(attempts.get("/observations/events")).toBe(2);
    expect(attempts.get("/observations/logs")).toBe(2);
  });

  it("keeps chronological loading and ready messages distinct", async () => {
    const events = Promise.withResolvers<Response>();
    const logs = Promise.withResolvers<Response>();
    const request = mockRequests((url) => url.pathname.endsWith("/events") ? events.promise : logs.promise);
    await renderDetails();
    expect(container.querySelector(".timeline-message")?.textContent).toBe("Loading observations…");
    expect(container.querySelector(".execution-logs-message")?.textContent).toBe("Loading logs…");
    expect(container.querySelector(".execution-view-switch")).toBeNull();
    for (const [url, init] of request.mock.calls) {
      expect(new URL(String(url)).searchParams.has("contextKey")).toBe(false);
      expect(init?.headers).toEqual({ accept: "application/json" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    await act(async () => {
      events.resolve(completed("first"));
      logs.resolve(Response.json({ items: [makeLog(1, "first")] }));
    });
    expect(container.querySelector(".timeline-message")).toBeNull();
    expect(container.querySelector(".execution-logs-message")).toBeNull();
    expect(container.textContent).toContain("execution.completed");
    expect(container.textContent).toContain("Log 1");
  });

  it("keeps grouped visibility defaults when new artifacts arrive and can switch both ways", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let includeLate = false;
    mockRequests((url) => {
      expect(url.searchParams.get("contextKey")).toBe("workflow.id");
      if (url.pathname.endsWith("/events")) return completed("observed");
      return Response.json({ items: [
        makeLog(1, "observed"),
        makeLog(2, "logs-only"),
        ...(includeLate ? [makeLog(3, "late")] : []),
      ] });
    });
    await renderDetails({ contextKey: "workflow.id", pollUntilCompleted: true, requestPending: true });
    const switcher = container.querySelector(".execution-view-switch")!;
    const [grouped, chronological] = switcher.querySelectorAll("button");
    const sections = (type: "logs" | "observations") => [...container.querySelectorAll<HTMLDetailsElement>(".execution-artifact-section")]
      .filter((element) => element.querySelector("strong")?.textContent === (type === "logs" ? "Logs" : "Observations"));
    expect(grouped?.classList.contains("active")).toBe(true);
    expect(grouped?.getAttribute("aria-pressed")).toBe("true");
    expect(chronological?.classList.contains("active")).toBe(false);
    expect(chronological?.getAttribute("aria-pressed")).toBe("false");
    expect([...container.querySelectorAll(".execution-group-count")].map((count) => count.textContent))
      .toEqual(["2 artifacts", "1 artifact"]);
    expect(container.querySelector('a[href="/executions/logs-only"]')?.textContent).toBe("Open execution");
    expect(container.textContent).toContain("Local Job · send logs");
    expect(container.querySelector(".execution-group-details")).toBeNull();
    expect(sections("logs").every((element) => element.open)).toBe(true);

    const [observationControls, logControls] = container.querySelectorAll(".artifact-visibility-controls");
    await act(async () => {
      observationControls?.querySelectorAll("button")[1]?.click();
      logControls?.querySelectorAll("button")[1]?.click();
    });
    expect(sections("logs").some((element) => element.open)).toBe(false);
    includeLate = true;
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(sections("logs")).toHaveLength(3);
    expect(sections("logs").some((element) => element.open)).toBe(false);
    expect(sections("observations").some((element) => element.open)).toBe(false);
    await act(async () => logControls?.querySelector("button")?.click());
    expect(sections("logs").every((element) => element.open)).toBe(true);

    await act(async () => chronological?.click());
    expect(chronological?.classList.contains("active")).toBe(true);
    expect(grouped?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".execution-artifact-group")).toBeNull();
    await act(async () => grouped?.click());
    expect(container.querySelector(".execution-artifact-group")).not.toBeNull();
  });

  it("keeps observed groups visible while their logs are pending or unavailable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const logs = Promise.withResolvers<Response>();
    const request = mockRequests((url) => url.pathname.endsWith("/events") ? completed("first") : logs.promise);
    await renderDetails({ contextKey: "workflow.id" });
    expect(container.querySelector(".execution-artifact-group")?.textContent).toContain("execution.completed");
    expect(container.querySelector(".execution-artifact-message")?.textContent).toBe("Loading logs…");
    expect(container.querySelector(".execution-correlated-message")).toBeNull();
    await act(async () => logs.resolve(new Response(null, { status: 503 })));
    expect(container.querySelector(".execution-artifact-group")?.textContent).toContain("execution.completed");
    expect(container.querySelector(".execution-correlated-message")?.textContent?.trim()).toBe("Execution logs request failed with status 503.");
    await act(async () => vi.advanceTimersByTimeAsync(2_100));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves a group-specific toggle through polling and applies the global default to later groups", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let later = false;
    const logs = vi.fn(() => Response.json({ items: [makeLog(1, "constructor"), ...(later ? [makeLog(2, "later")] : [])] }));
    mockRequests((url) => url.pathname.endsWith("/events") ? completed("constructor") : logs());
    await renderDetails({ contextKey: "workflow.id", pollUntilCompleted: true });
    const original = container.querySelectorAll<HTMLDetailsElement>(".execution-artifact-section");
    expect([...original].map(({ open }) => open)).toEqual([true, true]);
    await act(async () => {
      for (const section of original) {
        section.open = false;
        section.dispatchEvent(new Event("toggle"));
      }
    });
    later = true;
    await act(async () => vi.advanceTimersByTimeAsync(100));
    const current = container.querySelectorAll<HTMLDetailsElement>(".execution-artifact-section");
    expect([...current].map(({ open }) => open)).toEqual([false, false, true, true]);
    const controls = container.querySelectorAll(".artifact-visibility-controls");
    await act(async () => {
      for (const control of controls) control.querySelector("button")!.click();
    });
    expect([...current].every(({ open }) => open)).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1_900));
    expect(logs).toHaveBeenCalledTimes(21);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(logs).toHaveBeenCalledTimes(21);
  });
});

function makeLog(id: number, executionId: string) {
  return {
    id, loggedAt: timestamp, level: 30, message: `Log ${id}`,
    requestId: null, workload: null, createdAt: timestamp,
    payload: { executionId, operation: "send logs", transport: "local-job" },
  };
}
