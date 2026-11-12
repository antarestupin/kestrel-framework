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

function mockRequests(handler: (url: URL) => Response | Promise<Response>) {
  const request = vi.fn((input: RequestInfo | URL) => handler(new URL(String(input))));
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
});
