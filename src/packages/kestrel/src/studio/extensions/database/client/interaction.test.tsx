// @vitest-environment jsdom

import { createMemoryHistory, RouterContextProvider } from "@tanstack/react-router";
import { act, Profiler, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStudioRouter } from "../../../client/src/router.js";
import { getStudioPageRenderer } from "../../../client/src/page_renderer_registry.js";
import { DATABASE_SCHEMA_PAGE_KIND, type StudioDatabaseLayout } from "../contract.js";
import { useDatabaseDiagramLayout } from "./diagram_layout.js";
import { DatabaseLayout, DatabaseSchemaSection } from "./index.js";

const dataPath = "/studio/api/extensions/database/schema";
const layout: StudioDatabaseLayout = {
  schemas: [{
    name: "app",
    description: "Application schema",
    tables: [{
      name: "order",
      kind: "partitioned-table",
      origin: "framework",
      description: "Order partitions",
      columns: [{ name: "id", type: "uuid", nullable: false, primaryKey: true, description: "Order identity" }],
    }],
  }],
};

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
  try {
    await act(async () => root.unmount());
  } finally {
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

async function mountPage(endpoint?: `/${string}`, href = "/studio/database?tab=schema") {
  const { router, RouterProvider } = createStudioRouter({
    basePath: "/studio", icons: {},
    extensions: [{
      id: "database", title: "Database", section: { id: "database", title: "Database" },
      pages: [{
        id: "schema", kind: DATABASE_SCHEMA_PAGE_KIND, path: "/database", title: "Database schema",
        ...(endpoint === undefined ? {} : { dataPath: endpoint }),
      }],
    }],
  });
  router.update({ history: createMemoryHistory({ initialEntries: [href] }) });
  await router.load();
  await render(<RouterProvider router={router} />);
  return router;
}

function button(label: string) {
  const found = [...container.querySelectorAll("button")]
    .find((control) => (control.getAttribute("aria-label") ?? control.textContent.trim()) === label);
  expect(found, label).toBeDefined();
  return found!;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

describe("Studio database diagram", () => {
  it("preserves query parameters and updates the SVG export when toggling framework tables", async () => {
    const response = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetch);
    const router = await mountPage(dataPath);
    expect(container.textContent).toContain("Loading database schema");
    await act(async () => response.resolve(Response.json(layout)));
    expect(container.textContent).toContain("Partitioned");

    await click("Show comment for table app.order");
    const disclosure = button("Hide comment for table app.order");
    expect(disclosure.querySelector("svg.database-comment-chevron")).not.toBeNull();
    expect(document.getElementById(disclosure.getAttribute("aria-controls")!)?.hidden).toBe(false);
    await click("Hide comment for table app.order");
    expect(document.getElementById(disclosure.getAttribute("aria-controls")!)?.hidden).toBe(true);
    await click("Expand all comments");
    expect(button("Collapse all comments").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll(".database-comment-button[aria-expanded='true']")).toHaveLength(3);
    await click("Collapse all comments");
    expect(button("Expand all comments").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelectorAll(".database-comment-button[aria-expanded='true']")).toHaveLength(0);

    await click("Hide framework tables");
    expect(new URLSearchParams(router.state.location.searchStr).get("tab")).toBe("schema");
    expect(new URLSearchParams(router.state.location.searchStr).get("hideFramework")).toBe("true");
    expect(container.textContent).toContain("No tables remain after filtering");
    expect(container.querySelector(".database-diagram-link")?.getAttribute("href")).toBe(`${dataPath}.svg?hideFramework=true`);
    await click("Show framework tables");
    expect(new URLSearchParams(router.state.location.searchStr).has("hideFramework")).toBe(false);
    expect(container.querySelector(".database-diagram-link")?.getAttribute("href")).toBe(`${dataPath}.svg`);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(dataPath, {
      headers: { accept: "application/json" }, signal: expect.any(AbortSignal),
    });
    expect(router.history.length).toBe(1);
  });

  it("keeps comment disclosures distinct for quoted identifiers containing dots", async () => {
    await render(<DatabaseLayout layout={{ schemas: [
      { name: "a.b", tables: [{ name: "c", kind: "table", columns: [], description: "First table" }] },
      { name: "a", tables: [{ name: "b.c", kind: "table", columns: [], description: "Second table" }] },
    ] }} />);
    const [first, second] = container.querySelectorAll<HTMLButtonElement>(".database-comment-button");
    await act(async () => first!.click());
    expect(first?.getAttribute("aria-expanded")).toBe("true");
    expect(second?.getAttribute("aria-expanded")).toBe("false");
    await click("Expand all comments");
    expect(second?.getAttribute("aria-expanded")).toBe("true");
  });

  it("also allows standalone schema sections to expand a comment", async () => {
    await render(<DatabaseSchemaSection schema={layout.schemas[0]!} />);
    await click("Show comment for schema app");
    expect(container.querySelector(".database-schema-description")?.hasAttribute("hidden")).toBe(false);
    await click("Hide comment for schema app");
    expect(container.querySelector(".database-schema-description")?.hasAttribute("hidden")).toBe(true);
  });

  it("re-packs measured cards and releases its observer on unmount", async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    let measure!: () => void;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { measure = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    let height = 100;
    const commits = vi.fn();
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, 300, this.matches(".database-table-card") ? height : 60);
    });
    await render(<Profiler id="database diagram" onRender={commits}><DatabaseLayout layout={layout} /></Profiler>);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(bounds).toHaveBeenCalledTimes(2);
    const diagram = container.querySelector<HTMLElement>(".database-schema-groups")!;
    const initialHeight = parseInt(diagram.style.height, 10);
    height = 250;
    await act(async () => measure());
    expect(parseInt(diagram.style.height, 10)).toBeGreaterThan(initialHeight);
    const updatedHeight = diagram.style.height;
    // React may commit one more update immediately after the measured dimensions changed.
    await act(async () => measure());
    const stableCommits = commits.mock.calls.length;
    await act(async () => measure());
    expect(diagram.style.height).toBe(updatedHeight);
    expect(commits).toHaveBeenCalledTimes(stableCommits);
    await click("Hide framework tables");
    expect(disconnect).toHaveBeenCalledOnce();
    expect(diagram.querySelector("[data-database-measure]")).toBeNull();
    expect(container.querySelector(".database-diagram-link")).toBeNull();
    expect(container.textContent).toContain("0 tables across 0 schemas");
    expect(container.querySelector("[role='status']")?.textContent).toBe("No tables remain after filtering.");
    await click("Show framework tables");
    expect(observe).toHaveBeenCalledTimes(4);
    expect(container.querySelector(".database-layout-summary")?.textContent).toBe("1 table across 1 schema");
    expect(container.querySelector("[role='status']")).toBeNull();
    await render(null);
    expect(disconnect).toHaveBeenCalledTimes(3);
  });

  it("allows a layout consumer without a mounted measurement target", async () => {
    const observe = vi.fn();
    vi.stubGlobal("ResizeObserver", observe);
    function DiagramSummary() {
      const { diagram } = useDatabaseDiagramLayout(layout);
      return <p>{diagram.groups.length} schema</p>;
    }
    await render(<DiagramSummary />);
    expect(container.textContent).toContain("1 schema");
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([
    ["an HTTP error", () => Promise.resolve(new Response(null, { status: 403 })), "Database schema request failed with status 403."],
    ["an untyped error", () => Promise.reject("offline"), "Unable to load the database schema."],
    ["an empty schema", () => Promise.resolve(Response.json({ schemas: [] })), "No application tables found"],
  ] as const)("shows %s from the schema endpoint", async (_name, load, message) => {
    vi.stubGlobal("fetch", vi.fn(load));
    await mountPage(dataPath);
    expect(container.textContent).toContain(message);
  });

  it("reports a page without a schema endpoint without issuing a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await mountPage();
    expect(container.textContent).toContain("The database page has no data endpoint.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts the schema request when leaving the page", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    await mountPage(dataPath);
    await render(null);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("withdraws the old diagram before loading a replacement endpoint", async () => {
    const replacement = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(layout))
      .mockReturnValueOnce(replacement.promise);
    vi.stubGlobal("fetch", fetch);
    const { router } = createStudioRouter({ basePath: "/studio", icons: {}, extensions: [] });
    router.update({ history: createMemoryHistory({ initialEntries: ["/studio/database"] }) });
    const schemaPage = (endpoint: `/${string}`) => (
      <RouterContextProvider router={router}>
        {getStudioPageRenderer(DATABASE_SCHEMA_PAGE_KIND)!.render({
          id: "database", kind: DATABASE_SCHEMA_PAGE_KIND, path: "/database", title: "Database", dataPath: endpoint,
        })}
      </RouterContextProvider>
    );
    await render(schemaPage(dataPath));
    expect(container.querySelector(".database-diagram-link")?.getAttribute("href")).toBe(`${dataPath}.svg`);

    await render(schemaPage("/studio/other-database"));
    expect(container.textContent).toContain("Loading database schema");
    expect(container.querySelector(".database-layout")).toBeNull();
    await act(async () => replacement.resolve(Response.json({ schemas: [] })));
    expect(container.textContent).toContain("No application tables found");
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each(["success", "failure"] as const)("ignores stale %s from an aborted schema effect", async (outcome) => {
    const abandoned = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(abandoned.promise)
      .mockResolvedValueOnce(Response.json(layout));
    vi.stubGlobal("fetch", fetch);
    const { router } = createStudioRouter({ basePath: "/studio", icons: {}, extensions: [] });
    router.update({ history: createMemoryHistory({ initialEntries: ["/studio/database"] }) });
    await render(<StrictMode>
      <RouterContextProvider router={router}>
        {getStudioPageRenderer(DATABASE_SCHEMA_PAGE_KIND)!.render({
          id: "database", kind: DATABASE_SCHEMA_PAGE_KIND, path: "/database", title: "Database", dataPath,
        })}
      </RouterContextProvider>
    </StrictMode>);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "success") abandoned.resolve(Response.json({ schemas: [] }));
      else abandoned.reject(new Error("Old database schema unavailable"));
    });
    expect(container.querySelector(".database-layout")).not.toBeNull();
    expect(container.querySelector(".error-panel")).toBeNull();
  });
});
