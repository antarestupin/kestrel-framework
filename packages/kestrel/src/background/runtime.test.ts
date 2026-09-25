import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { readRequestedWorkloads } from "./provider.js";
import {
  BackgroundRuntime,
  type BackgroundWorkloadRuntime,
} from "./runtime.js";

describe("BackgroundRuntime", () => {
  it("starts only selected workloads and stops them in reverse order", async () => {
    const calls: string[] = [];
    const app = { stop: vi.fn(async () => { calls.push("app:stop"); }) };
    const workers = runtime("workers", calls);
    const workflows = runtime("workflows", calls);
    const background = new BackgroundRuntime(
      app as never,
      { workers, workflows },
      { waitForShutdown: async () => { calls.push("signal"); } },
    );

    await background.run(["workers", "workflows"]);

    expect(calls).toEqual([
      "workers:start",
      "workflows:start",
      "signal",
      "workflows:stop",
      "workers:stop",
      "app:stop",
    ]);
  });

  it("rejects unavailable workloads before polling", async () => {
    const background = new BackgroundRuntime(
      { stop: async () => undefined } as never,
      { workers: runtime("workers", []) },
      { waitForShutdown: async () => undefined },
    );

    expect(background.availableWorkloads()).toEqual(["workers"]);
    await expect(background.run(["workflows"]))
      .rejects.toThrow("Unavailable background workload");
  });
});

describe("readRequestedWorkloads", () => {
  it("reads repeatable and inline workload options before bootstrap", () => {
    expect(readRequestedWorkloads(
      [
        "run",
        "background",
        "--workload",
        "workers",
        "--workload=workflows",
      ],
      ["workers", "workflows"],
    )).toEqual(["workers", "workflows"]);
  });

  it("uses every available workload by default", () => {
    expect(readRequestedWorkloads(
      ["run", "background"],
      ["scheduled-tasks", "workflows"],
    )).toEqual(["scheduled-tasks", "workflows"]);
  });
});

function runtime(
  name: string,
  calls: string[],
): BackgroundWorkloadRuntime {
  return {
    start: () => { calls.push(`${name}:start`); },
    stop: async () => { calls.push(`${name}:stop`); },
  };
}
