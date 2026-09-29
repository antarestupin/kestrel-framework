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

    await expect(Promise.all(kinds.map(loadStudioPageRenderer))).resolves
      .toEqual(kinds.map((kind) => expect.objectContaining({ kind })));
  });

  it("keeps pages without an installed client renderer supported", async () => {
    await expect(loadStudioPageRenderer("custom-page")).resolves.toBeUndefined();
  });
});
