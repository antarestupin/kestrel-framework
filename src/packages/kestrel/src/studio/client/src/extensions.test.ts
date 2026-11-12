import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createStudioPageLoader, loadStudioPageRenderer } from "./extensions.js";
import type { StudioPageRenderer } from "./page_renderer.js";

describe("Studio client extensions", () => {
  it("reuses a pending load, retries a failure, and resolves the registered renderer", async () => {
    const kind = "retry-page";
    const chunk = Promise.withResolvers<void>();
    const load = vi.fn<() => Promise<void>>().mockReturnValueOnce(chunk.promise).mockResolvedValueOnce(undefined);
    const renderer = { kind, render: () => null };
    const resolve = vi.fn<(kind: string) => StudioPageRenderer | undefined>().mockReturnValue(undefined);
    const loadPage = createStudioPageLoader([{ pageKinds: [kind], load }], resolve);
    const first = loadPage(kind);
    const duplicate = loadPage(kind);
    const failed = Promise.allSettled([first, duplicate]);
    const error = new Error("Chunk could not be downloaded");
    chunk.reject(error);
    expect(await failed).toEqual([
      { status: "rejected", reason: error },
      { status: "rejected", reason: error },
    ]);
    expect(load).toHaveBeenCalledOnce();

    const retry = loadPage(kind);
    resolve.mockReturnValue(renderer);
    await expect(retry).resolves.toBe(renderer);
    expect(load).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenLastCalledWith(kind);

    // Hot refresh can replace the registered renderer after a successful load.
    const replacement = { kind, render: () => "updated" };
    resolve.mockReturnValue(replacement);
    await expect(loadPage(kind)).resolves.toBe(replacement);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads every built-in extension renderer on demand", async () => {
    const kinds = [
      "actions-list",
      "controllers.explorer",
      "database-schema",
      "development-observations",
      "development-observation-correlation",
      "development-observation-execution",
      "development-observation-list",
      "development-logs",
      "scheduled-tasks.catalog",
      "workers.queues",
      "workers.worker",
      "workflows.catalog",
      "workflows.execution",
    ];

    // Navigation and intent preload can request the same lazy renderer together.
    const loads = kinds.map(loadStudioPageRenderer);
    const concurrent = loadStudioPageRenderer(kinds[0]!);
    await expect(Promise.all(loads)).resolves
      .toEqual(kinds.map((kind) => expect.objectContaining({ kind })));
    expect(await concurrent).toBe(await loads[0]);
  });

  it("keeps pages without an installed client renderer supported", async () => {
    await expect(loadStudioPageRenderer("custom-page")).resolves.toBeUndefined();
  });
});
