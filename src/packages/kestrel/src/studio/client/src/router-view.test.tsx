import { createMemoryHistory } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StudioManifest, StudioPageManifest } from "../../extension.js";
import { loadStudioPageRenderer } from "./extensions.js";
import { createStudioRouter } from "./router.js";

describe("Studio client pages", () => {
  it.each([
    ["actions-list", "Loading action contracts"],
    ["controllers.explorer", "Loading HTTP controllers"],
    ["development-email-history", "Loading email data"],
    ["development-email-inbox", "Loading email data"],
    ["development-logs", "Loading structured logs"],
    ["development-observation-list", "Loading observations"],
    ["development-observations", "Loading observed executions"],
    ["scheduled-tasks.catalog", "Loading scheduled tasks"],
    ["workers.queues", "Loading worker queues"],
    ["workflows.catalog", "Loading workflows"],
  ])("renders a loading state and a clear missing-endpoint message for %s", async (kind, loadingText) => {
    const renderer = await loadStudioPageRenderer(kind);
    expect(renderer).toBeDefined();
    const page = { kind, id: "preview", path: "/preview", title: "Preview" } as const;
    const missing = renderToStaticMarkup(renderer!.render(page));
    expect(missing).toContain("<h1>Preview</h1>");
    expect(missing).toContain("has no data endpoint");
    const loading = renderToStaticMarkup(renderer!.render({ ...page, dataPath: "/_studio/api/preview" }));
    expect(loading).toContain(loadingText);
    expect(loading).not.toContain("has no data endpoint");
  });

  it("loads a hidden correlation route at the configured base without exposing it in navigation", async () => {
    const page: StudioPageManifest = {
      kind: "development-observation-correlation",
      id: "correlation",
      path: "/correlations/$contextKey/$executionId",
      title: "Correlated execution",
      dataPath: "/tools/api/observations",
      showInNavigation: false,
    };
    const manifest: StudioManifest = {
      basePath: "/tools", icons: {},
      extensions: [{
        id: "diagnostics", title: "Diagnostics", section: { id: "tools", title: "Tools" },
        pages: [page],
        links: [{ id: "guide", href: "https://example.test/guide", title: "Guide" }],
      }],
    };
    const { router, RouterProvider } = createStudioRouter(manifest);
    router.update({
      history: createMemoryHistory({ initialEntries: ["/tools/correlations/workflow.id/run-1"] }),
    });
    await router.load();

    const markup = renderToStaticMarkup(<RouterProvider router={router} />);
    expect(markup).toContain("<h1>Correlated execution</h1>");
    expect(markup).toContain("Loading observations");
    expect(markup).toContain('aria-label="Timeline display"');
    expect(markup).toContain('href="/tools/correlations/workflow.id/run-1"');
    expect(markup).toContain('href="https://example.test/guide"');
    expect(markup).not.toContain(">Correlated execution</a>");
  });
});
