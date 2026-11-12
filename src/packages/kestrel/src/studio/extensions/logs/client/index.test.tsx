// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadStudioPageRenderer } from "../../../client/src/extensions.js";
import { DEV_LOGS_PAGE_KIND, type StudioLogPage } from "../contract.js";

const dataPath = "/studio/logs";

function pageOf(id: number, message: string, nextBefore: number | null = null): Response {
  return Response.json({
    items: [{
      id, loggedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z",
      level: 50, workload: "workers", requestId: null, message, payload: {},
    }],
    nextBefore,
  } satisfies StudioLogPage);
}

describe("Studio log explorer interactions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

  async function render(endpoint: `/${string}` | null = dataPath) {
    const renderer = await loadStudioPageRenderer(DEV_LOGS_PAGE_KIND);
    expect(renderer).toBeDefined();
    await act(async () => root.render(renderer!.render({
      kind: DEV_LOGS_PAGE_KIND, id: "logs", path: "/logs", title: "Logs",
      ...(endpoint === null ? {} : { dataPath: endpoint }),
    })));
  }

  async function click(text: string) {
    const button = [...container.querySelectorAll("button")]
      .find((element) => element.textContent?.trim() === text);
    if (button === undefined) throw new Error(`Missing button: ${text}`);
    await act(async () => button.click());
  }

  it("keeps the current filter when an earlier request resolves later", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    const current = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(current.promise)
      .mockResolvedValueOnce(pageOf(9, "Older worker error"));
    await render();
    expect(container.textContent).toContain("Loading structured logs");
    expect(container.querySelector(".error-panel")).toBeNull();
    expect(Object.fromEntries(new URL(String(fetchMock.mock.lastCall?.[0])).searchParams)).toEqual({ limit: "50" });

    await click("Error");
    await click("Workers");
    expect(container.querySelector(".loading-panel")).not.toBeNull();
    expect([...container.querySelectorAll(".log-filter-options button.active")].map((control) => control.textContent))
      .toEqual(["Error", "Workers"]);
    expect(container.querySelectorAll(".log-filter-options button:not(.active)")).toHaveLength(11);
    expect(fetchMock.mock.lastCall?.[1]).toMatchObject({ headers: { accept: "application/json" } });
    // Simulate a stale response even if cancellation has already been requested.
    await act(async () => {
      first.resolve(pageOf(12, "Unfiltered entry"));
      second.resolve(pageOf(11, "Entry from any workload"));
    });
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => current.resolve(pageOf(10, "Current worker error", 10)));
    expect(container.textContent).not.toContain("Unfiltered entry");
    expect(container.textContent).not.toContain("Entry from any workload");
    expect(container.textContent).toContain("Current worker error");
    expect(container.querySelector(".loading-panel")).toBeNull();
    expect(container.querySelector(".error-panel")).toBeNull();

    await click("Load older logs");
    const url = fetchMock.mock.lastCall?.[0] as URL;
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      level: "50", workload: "workers", before: "10",
    });
    expect(container.textContent).toContain("Current worker error");
    expect(container.textContent).toContain("Older worker error");
  });

  it("reports an unsuccessful clear and reloads the list after a successful retry", async () => {
    fetchMock.mockResolvedValueOnce(pageOf(10, "Stored message"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ items: [], nextBefore: null }));
    await render();
    expect(container.textContent).toContain("Stored message");

    await click("Clear logs");
    expect(container.textContent).toContain("Clearing logs failed with status 503");
    await click("Clear logs");
    expect(container.textContent).toContain("Network unavailable");
    await click("Clear logs");
    expect(fetchMock.mock.calls[3]?.[0]).toBe(dataPath);
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("DELETE");
    expect(container.textContent).toContain("No logs match this filter");
  });

  it("replaces a failed read with the results of the next filter", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(pageOf(10, "Worker error after recovery"));
    await render();
    expect(container.textContent).toContain("Logs request failed with status 502");

    await click("Workers");
    expect(container.textContent).not.toContain("Logs request failed");
    expect(container.textContent).toContain("Worker error after recovery");
  });

  it("reports a missing endpoint without requesting logs", async () => {
    await render(null);
    expect(container.querySelector(".error-panel")?.textContent).toBe("The logs page has no data endpoint.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("distinguishes untyped read and delete failures from cancellation", async () => {
    const abandoned = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(abandoned.promise)
      .mockRejectedValueOnce("Read unavailable")
      .mockRejectedValueOnce("Clear unavailable");
    await render();
    await click("Workers");
    expect(container.querySelector(".error-panel")?.textContent).toBe("Unable to load logs.");
    await act(async () => abandoned.reject(new Error("Abandoned log read")));
    expect(container.querySelector(".error-panel")?.textContent).toBe("Unable to load logs.");
    await click("Clear logs");
    expect(container.querySelector(".error-panel")?.textContent).toBe("Unable to clear logs.");
  });

  it("retains loaded older log entries during polling until the log is cleared", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const refreshed = Promise.withResolvers<Response>();
    fetchMock.mockResolvedValueOnce(pageOf(10, "Original message", 10))
      .mockResolvedValueOnce(pageOf(9, "Older message"))
      .mockResolvedValueOnce(pageOf(11, "Live message", 11))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockReturnValueOnce(refreshed.promise);
    await render();
    await click("Load older logs");
    expect(container.textContent).toContain("Older message");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.textContent).toContain("Live message");
    expect(container.textContent).toContain("Older message");
    expect(container.textContent).not.toContain("Load older logs");

    await click("Clear logs");
    expect(container.querySelector(".loading-panel")?.textContent).toBe("Loading structured logs…");
    expect(container.textContent).not.toContain("Older message");
    await act(async () => refreshed.resolve(Response.json({ items: [], nextBefore: null })));
    expect(container.textContent).toContain("No logs match this filter.");
    expect(container.textContent).not.toContain("Older message");
  });

  it("replaces a live first page and deduplicates older entries with the updated cursor", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const shared = await pageOf(11, "Current message", 8).json() as StudioLogPage;
    const older = await pageOf(7, "Older message").json() as StudioLogPage;
    fetchMock.mockResolvedValueOnce(pageOf(10, "Replaced message", 10))
      .mockResolvedValueOnce(Response.json(shared))
      .mockResolvedValueOnce(Response.json({ items: [...shared.items, ...older.items], nextBefore: null }));
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.textContent).not.toContain("Replaced message");
    expect(container.textContent).toContain("Current message");
    await click("Load older logs");
    expect(new URL(String(fetchMock.mock.lastCall?.[0])).searchParams.get("before")).toBe("8");
    expect([...container.querySelectorAll(".log-message")].map((item) => item.textContent))
      .toEqual(["Current message", "Older message"]);
  });

  it("cannot restore deleted logs from a read started before clearing", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stale = Promise.withResolvers<Response>();
    fetchMock.mockResolvedValueOnce(pageOf(10, "Stored message"))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ items: [], nextBefore: null }));
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    const signal = fetchMock.mock.calls[1]?.[1]?.signal;
    await click("Clear logs");
    expect(container.textContent).toContain("No logs match this filter");

    await act(async () => stale.resolve(pageOf(10, "Stored message")));
    expect(container.textContent).not.toContain("Stored message");
    expect(signal?.aborted).toBe(true);
  });

  it("deduplicates a pending clear and reloads the filter selected while it was running", async () => {
    const clear = Promise.withResolvers<Response>();
    const read = (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return clear.promise;
      const url = new URL(String(input));
      return url.searchParams.get("level") === "50" ? pageOf(11, "Filtered error") : pageOf(10, "All logs", 10);
    };
    fetchMock.mockImplementation(async (input, init) => read(input, init));
    await render();
    const clearButton = container.querySelector<HTMLButtonElement>(".clear-logs-button")!;
    await act(async () => {
      clearButton.click();
      clearButton.click();
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    await click("Load older logs");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await click("Error");
    expect(container.textContent).toContain("Filtered error");
    fetchMock.mockResolvedValueOnce(Response.json({ items: [], nextBefore: null }));
    await act(async () => clear.resolve(new Response(null, { status: 204 })));
    expect(container.textContent).toContain("No logs match this filter");
    expect(new URL(String(fetchMock.mock.lastCall?.[0])).searchParams.get("level")).toBe("50");
  });

  it("keeps the newly selected filter when a clear from the former view fails", async () => {
    const deletion = Promise.withResolvers<Response>();
    fetchMock.mockResolvedValueOnce(pageOf(10, "Unfiltered message"))
      .mockReturnValueOnce(deletion.promise)
      .mockResolvedValueOnce(pageOf(11, "Selected filter message"));
    await render();
    await click("Clear logs");
    await click("Workers");
    await act(async () => deletion.reject(new Error("Previous clear failed")));
    expect(container.querySelector(".error-panel")).toBeNull();
    expect(container.textContent).toContain("Selected filter message");
  });

  it("skips overlapping background polls and releases the filter on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockResolvedValueOnce(pageOf(10, "Current message")).mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const signal = fetchMock.mock.lastCall?.[1]?.signal;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null));
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => pending.resolve(pageOf(9, "Retired log")));
  });
});
