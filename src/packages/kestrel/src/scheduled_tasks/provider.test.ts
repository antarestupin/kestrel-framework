import {
  describe,
  expect,
  it,
} from "vitest";

import { App } from "../app/index.js";
import type { ScheduledTasksConfig } from "./configuration.js";
import { scheduledTaskAdapterDependency } from "./dependencies.js";
import { ScheduledTaskProvider } from "./provider.js";

const config: ScheduledTasksConfig = {
  slots: 2,
  leaseMs: 30_000,
  pollIntervalMs: 100,
  defaultState: "persistent",
  defaultCoordination: "distributed",
  expiredRunPruneBatchSize: 10,
  expiredRunPruneIntervalSeconds: 0,
};

describe("ScheduledTaskProvider", () => {
  it("registers persistent occurrence state lazily", async () => {
    const app = new App({ name: "test" }).register(
      new ScheduledTaskProvider(config),
    );

    expect(app.container.hasRegistration(scheduledTaskAdapterDependency.id)).toBe(true);
    await app.dispose();
  });

  it("contributes maintenance from its injected configuration", async () => {
    const app = new App({ name: "test" }).register(
      new ScheduledTaskProvider({
        ...config,
        expiredRunPruneIntervalSeconds: 60,
      }),
    );

    expect(app.catalog.scheduledTasks.registrations).toMatchObject([{
      task: {
        id: "maintenance.scheduled-task-runs-prune",
        groups: ["maintenance"],
        executionLog: false,
        observe: false,
      },
      source: { kind: "provider", provider: "ScheduledTaskProvider" },
    }]);

    await app.dispose();
  });
});
