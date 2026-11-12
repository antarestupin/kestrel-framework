import {
  describe,
  expect,
  it,
} from "vitest";

import { loadStudioPageRenderer } from "./extensions.js";

describe("Studio client extensions", () => {
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
