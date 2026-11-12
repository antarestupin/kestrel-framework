// @vitest-environment jsdom

import { createMemoryHistory } from "@tanstack/react-router";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStudioRouter } from "../../../client/src/router.js";
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
    expect(document.getElementById(disclosure.getAttribute("aria-controls")!)?.hidden).toBe(false);
    await click("Hide comment for table app.order");
    await click("Expand all comments");
    expect(container.querySelectorAll(".database-comment-button[aria-expanded='true']")).toHaveLength(3);
    await click("Collapse all comments");
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
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 300, height));
    await render(<DatabaseLayout layout={layout} />);
    expect(observe).toHaveBeenCalledTimes(2);
    const diagram = container.querySelector<HTMLElement>(".database-schema-groups")!;
    const initialHeight = parseInt(diagram.style.height, 10);
    height = 250;
    await act(async () => measure());
    expect(parseInt(diagram.style.height, 10)).toBeGreaterThan(initialHeight);
    const updatedHeight = diagram.style.height;
    await act(async () => measure());
    expect(diagram.style.height).toBe(updatedHeight);
    await render(null);
    expect(disconnect).toHaveBeenCalledOnce();
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
});
