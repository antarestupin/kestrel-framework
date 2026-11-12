import { setImmediate } from "node:timers/promises";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ApplicationShutdown } from "../app/index.js";
import { readRequestedWorkloads } from "./provider.js";
import {
  BackgroundRuntime,
  type BackgroundWorkloadRuntime,
} from "./runtime.js";

describe("BackgroundRuntime", () => {
  it("asks every peer to stop and retains synchronous and asynchronous cleanup errors", async () => {
    const calls: string[] = [];
    const syncFailure = new Error("synchronous workload stop failure");
    const asyncFailure = new Error("asynchronous workload stop failure");
    const app = { shutdown: new ApplicationShutdown(), stop: vi.fn(async () => { calls.push("app:stop"); }) };
    const workers = runtime("workers", calls);
    const scheduled = { start: () => { calls.push("scheduled:start"); }, stop: async () => { calls.push("scheduled:stop"); throw asyncFailure; } };
    const workflows = { start: () => { calls.push("workflows:start"); }, stop: (): Promise<void> => { calls.push("workflows:stop"); throw syncFailure; } };
    const background = new BackgroundRuntime(app as never, { workers, "scheduled-tasks": scheduled, workflows }, {
      waitForShutdown: async () => { await vi.waitFor(() => expect(calls).toContain("workflows:start")); },
    });
    let failure: unknown;
    try { await background.run(["workers", "scheduled-tasks", "workflows"]); } catch (error) { failure = error; } finally { app.shutdown.finish(); }
    // A callback can throw before returning its promised cleanup; every sibling still owns a drain.
    expect(calls).toEqual(["workers:start", "scheduled:start", "workflows:start", "app:stop", "workflows:stop", "scheduled:stop", "workers:stop"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe("Background workload shutdown failed.");
    expect((failure as AggregateError).errors).toEqual([syncFailure, asyncFailure]);
  });

  for (const selection of [[], ["workers", "workers", "workflows"]] as const) {
    it(`selects available workloads once for ${JSON.stringify(selection)}`, async () => {
      const calls: string[] = [];
      const app = { shutdown: new ApplicationShutdown(), stop: async () => undefined };
      const background = new BackgroundRuntime(app as never, { workers: runtime("workers", calls), workflows: runtime("workflows", calls) }, {
        waitForShutdown: async () => { await vi.waitFor(() => expect(calls).toContain("workflows:start")); },
      });
      try { await background.run(selection); } finally { app.shutdown.finish(); }
      expect(background.availableWorkloads()).toEqual(["workers", "workflows"]);
      expect(calls).toEqual(["workers:start", "workflows:start", "workflows:stop", "workers:stop"]);
    });
  }

  for (const outcome of ["rejected", "fulfilled"] as const) {
    it(`observes a ${outcome} polling completion while a later workload is still starting`, async () => {
      const calls: string[] = [];
      const failure = new Error("polling failed during peer startup");
      const completion = Promise.withResolvers<void>();
      const starting = Promise.withResolvers<void>();
      const shutdown = Promise.withResolvers<void>();
      // Keep a deliberately rejected fixture promise observed even if a mutant removes supervision.
      void completion.promise.catch(() => undefined);
      const app = { shutdown: new ApplicationShutdown(), stop: async () => { calls.push("app:stop"); } };
      const workers = { ...runtime("workers", calls), completion: completion.promise };
      const workflows = {
        start: () => { calls.push("workflows:start"); if (outcome === "rejected") completion.reject(failure); else completion.resolve(); return starting.promise; },
        stop: async () => { calls.push("workflows:stop"); starting.resolve(); },
      };
      const background = new BackgroundRuntime(app as never, { workers, workflows, "scheduled-tasks": runtime("scheduled", calls) }, { waitForShutdown: () => shutdown.promise });
      let observed: { error?: unknown; completed: boolean } | undefined;
      const running = background.run(["workers", "workflows", "scheduled-tasks"]).then(() => { observed = { completed: true }; }, (error: unknown) => { observed = { error, completed: false }; });
      let beforeFallback: typeof observed;
      try {
        // This controlled fixture has only finite promise continuations, with no storage or poller I/O.
        await setImmediate();
        beforeFallback = observed;
      } finally {
        // Release both gates before awaiting a potentially mutated owner, avoiding test-deadline kills.
        shutdown.resolve();
        starting.resolve();
        await running;
        app.shutdown.finish();
      }
      expect(beforeFallback?.completed).toBe(false);
      if (outcome === "rejected") expect(beforeFallback?.error).toBe(failure);
      else expect(beforeFallback?.error).toMatchObject({ message: "Background polling terminated during startup." });
      expect(calls).toEqual(["workers:start", "workflows:start", "app:stop", "workflows:stop", "workers:stop"]);
    });
  }

  it("supervises a polling lifetime published by the workload while it is still starting", async () => {
    const calls: string[] = [];
    const failure = new Error("polling failed before startup returned");
    const polling = Promise.withResolvers<void>();
    const starting = Promise.withResolvers<void>();
    const shutdown = Promise.withResolvers<void>();
    void polling.promise.catch(() => undefined);
    let completion: Promise<void> | undefined;
    const workers = {
      start: () => {
        calls.push("workers:start");
        completion = polling.promise;
        polling.reject(failure);
        return starting.promise;
      },
      get completion() { return completion; },
      stop: async () => { calls.push("workers:stop"); starting.resolve(); },
    };
    const app = { shutdown: new ApplicationShutdown(), stop: async () => { calls.push("app:stop"); } };
    const background = new BackgroundRuntime(
      app as never,
      { workers, workflows: runtime("workflows", calls) },
      { waitForShutdown: () => shutdown.promise },
    );
    const observed = vi.fn();
    const running = background.run(["workers", "workflows"]).catch(observed);
    try {
      // Observe termination while the explicit startup and shutdown gates remain pending.
      await setImmediate();
      expect(observed).toHaveBeenCalledExactlyOnceWith(failure);
      expect(calls).toEqual(["workers:start", "app:stop", "workers:stop"]);
    } finally {
      shutdown.resolve();
      starting.resolve();
      await running;
      app.shutdown.finish();
    }
  });

  it.each(["fulfilled", "rejected"] as const)("drains every workload when steady-state polling is %s", async (outcome) => {
    const calls: string[] = [];
    const completion = Promise.withResolvers<void>();
    const shutdown = Promise.withResolvers<void>();
    const failure = new Error("polling failed in steady state");
    void completion.promise.catch(() => undefined);
    const workers = { ...runtime("workers", calls), completion: completion.promise };
    const app = { shutdown: new ApplicationShutdown(), stop: async () => { calls.push("app:stop"); } };
    const background = new BackgroundRuntime(
      app as never,
      { workers, workflows: runtime("workflows", calls) },
      { waitForShutdown: () => shutdown.promise },
    );
    const observed = vi.fn();
    const running = background.run([]).catch(observed);
    try {
      // Give the supervisor a turn to reach steady state before settling its poller.
      await setImmediate();
      expect(calls).toEqual(["workers:start", "workflows:start"]);
      if (outcome === "rejected") completion.reject(failure);
      else completion.resolve();
      await setImmediate();
      expect(observed).toHaveBeenCalledExactlyOnceWith(outcome === "rejected"
        ? failure
        : expect.objectContaining({ message: "Runtime polling terminated before shutdown was requested." }));
      expect(calls).toEqual(["workers:start", "workflows:start", "app:stop", "workflows:stop", "workers:stop"]);
    } finally {
      shutdown.resolve();
      completion.resolve();
      await running;
      app.shutdown.finish();
    }
  });

  it("does not start a later workload after owner cancellation interrupts startup", async () => {
    const calls: string[] = [];
    const starting = Promise.withResolvers<void>();
    const app = { shutdown: new ApplicationShutdown(), stop: async () => { calls.push("app:stop"); } };
    const workers = { start: () => { calls.push("workers:start"); return starting.promise; }, stop: async () => { calls.push("workers:stop"); starting.resolve(); } };
    const background = new BackgroundRuntime(app as never, { workers, workflows: runtime("workflows", calls) }, { waitForShutdown: async () => undefined });
    try {
      await background.run(["workers", "workflows"]);
      // Drain finite continuations from the interrupted start before checking admission.
      await setImmediate();
    } finally { starting.resolve(); app.shutdown.finish(); }
    expect(calls).toEqual(["workers:start", "app:stop", "workers:stop"]);
  });

  it("includes a partially started workload in cleanup and skips later startup", async () => {
    const calls: string[] = [];
    const startupFailure = new Error("partial workflow startup failed");
    const app = { shutdown: new ApplicationShutdown(), stop: async () => { calls.push("app:stop"); } };
    const workflows = { start: () => { calls.push("workflows:start"); throw startupFailure; }, stop: async () => { calls.push("workflows:stop"); } };
    const background = new BackgroundRuntime(app as never, { workers: runtime("workers", calls), workflows, "scheduled-tasks": runtime("scheduled", calls) }, {
      // Model an owner-owned wait without touching process signals; cancellation removes its listener.
      waitForShutdown: (signal) => new Promise((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); }),
    });
    try { await expect(background.run(["workers", "workflows", "scheduled-tasks"])).rejects.toBe(startupFailure); } finally { app.shutdown.finish(); }
    expect(calls).toEqual(["workers:start", "workflows:start", "app:stop", "workflows:stop", "workers:stop"]);
  });

  it("starts only selected workloads and stops them in reverse order", async () => {
    const calls: string[] = [];
    const app = { shutdown: new ApplicationShutdown(), stop: vi.fn(async () => { calls.push("app:stop"); }) };
    const workers = runtime("workers", calls);
    const workflows = runtime("workflows", calls);
    const background = new BackgroundRuntime(
      app as never,
      { workers, workflows },
      { waitForShutdown: async () => { await vi.waitFor(() => expect(calls).toContain("workflows:start")); calls.push("signal"); } },
    );

    try { await background.run(["workers", "workflows"]); } finally { app.shutdown.finish(); }

    expect(calls).toEqual([
      "workers:start",
      "workflows:start",
      "signal",
      "app:stop",
      "workflows:stop",
      "workers:stop",
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
  it("deduplicates selections in requested order and ignores unrelated CLI arguments", () => {
    expect(readRequestedWorkloads(["run", "background", "--other=value", "--workload=workflows", "--workload", "workers", "--workload=workflows"], ["workers", "workflows"])).toEqual(["workflows", "workers"]);
    expect(readRequestedWorkloads([], [])).toEqual([]);
  });

  it.each([
    { arguments_: ["--workload", "unknown"], message: 'Unknown background workload: "unknown".' },
    { arguments_: ["--workload="], message: 'Unknown background workload: "".' },
    { arguments_: ["--workload=workflows"], message: 'Unavailable background workload: "workflows".' },
    { arguments_: ["--workload"], message: "Missing value for --workload." },
  ])("rejects an invalid, unavailable or missing selection with $message", ({ arguments_, message }) => {
    expect(() => readRequestedWorkloads(arguments_, ["workers"])).toThrow(new TypeError(message));
  });

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
