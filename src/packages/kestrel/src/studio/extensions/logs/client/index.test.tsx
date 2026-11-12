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
      vi.unstubAllGlobals();
    }
  });

  async function render() {
    const renderer = await loadStudioPageRenderer(DEV_LOGS_PAGE_KIND);
    expect(renderer).toBeDefined();
    await act(async () => root.render(renderer!.render({
      kind: DEV_LOGS_PAGE_KIND, id: "logs", path: "/logs", title: "Logs", dataPath,
    })));
  }

  async function click(text: string) {
    const button = [...container.querySelectorAll("button")]
      .find((element) => element.textContent?.trim() === text);
    if (button === undefined) throw new Error(`Missing button: ${text}`);
    await act(async () => button.click());
  }

  it("keeps the current filter when an earlier request resolves later", async () => {
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(pageOf(10, "Current worker error", 10))
      .mockResolvedValueOnce(pageOf(9, "Older worker error"));
    await render();
    expect(container.textContent).toContain("Loading structured logs");

    await click("Error");
    await click("Workers");
    expect(container.textContent).toContain("Current worker error");
    // Simulate a stale response even if cancellation has already been requested.
    await act(async () => {
      first.resolve(pageOf(12, "Unfiltered entry"));
      second.resolve(pageOf(11, "Entry from any workload"));
    });
    expect(container.textContent).not.toContain("Unfiltered entry");
    expect(container.textContent).not.toContain("Entry from any workload");
    expect(container.textContent).toContain("Current worker error");

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
});
