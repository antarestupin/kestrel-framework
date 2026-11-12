import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { App, executionCompletedEvent, executionContextDependency } from "./index.js";
import { executionCompletedObservation, executionStartedObservation } from "./observations.js";

describe("direct execution cleanup", () => {
  it("records direct start metadata and the elapsed time of a successful action", async () => {
    const app = new App({});
    const record = vi.fn();
    app.container.registerValue("observer", { record });
    const action = defineAction({
      name: "example.timed",
      input: z.null(),
      output: z.null(),
      dependencies: { context: executionContextDependency },
      handler(_input, { context }) {
        expect(context.toRecord("log")).toMatchObject({ operation: "example.timed", transport: "direct" });
        clock.mockReturnValue(112);
        return null;
      },
    });
    await app.start();
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    try {
      await expect(app.get(action).run(null)).resolves.toBeNull();
      expect(record.mock.calls).toEqual([
        [executionStartedObservation, { operation: "example.timed", transport: "direct" }],
        [executionCompletedObservation, { operation: "example.timed", transport: "direct" }, { outcome: "success", durationMs: 12 }],
      ]);
    } finally {
      clock.mockRestore();
      await app.dispose();
    }
  });

  it.each([
    { stage: "log metadata", outcome: "failure" },
    { stage: "start observation", outcome: "failure" },
    { stage: "completion observation", outcome: "success" },
  ])("releases the scope when $stage fails", async ({ stage, outcome }) => {
    const app = new App({}, { executionContext: { maxEntrySizeBytes: 80 } });
    const action = defineAction({
      name: stage === "log metadata" ? `example.${"long".repeat(30)}` : "example.run",
      input: z.null(),
      output: z.null(),
      handler: () => null,
    });
    const complete = vi.fn();
    app.eventBus.listen(executionCompletedEvent, complete, { scope: "descendants" });
    app.container.registerValue("observer", {
      record(definition: unknown) {
        if ((stage === "start observation" && definition === executionStartedObservation)
          || (stage === "completion observation" && definition === executionCompletedObservation)) {
          throw new Error(`${stage} failed`);
        }
      },
    });

    // Capture the owned scope so teardown can also release it before the regression is fixed.
    const createExecutionScope = app.createExecutionScope.bind(app);
    let scope: Awaited<ReturnType<typeof createExecutionScope>> | undefined;
    const createScope = vi.spyOn(app, "createExecutionScope").mockImplementation(async () => {
      scope = await createExecutionScope();
      return scope;
    });

    try {
      const message = stage === "log metadata" ? "entry limit" : `${stage} failed`;
      await expect(app.get(action).run(null)).rejects.toThrow(message);
      expect(complete).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome }), expect.anything());
      await expect(app.dispose()).resolves.toBeUndefined();
    } finally {
      createScope.mockRestore();
      await scope?.dispose();
      await app.dispose();
    }
  });

  it.each([
    { label: "undefined", reason: undefined, message: "undefined" },
    {
      label: "an unprintable value",
      reason: Object.create(null) as unknown,
      message: "The thrown value could not be converted to a string.",
    },
  ])("observes a rejection with $label and preserves the original failure", async ({ reason, message }) => {
    const app = new App({});
    const record = vi.fn();
    app.container.registerValue("observer", { record });
    const action = defineAction({
      name: "example.reject",
      input: z.null(),
      output: z.null(),
      handler: () => Promise.reject(reason),
    });

    try {
      await expect(app.get(action).run(null)).rejects.toBe(reason);
      expect(record).toHaveBeenCalledWith(executionCompletedObservation, expect.objectContaining({
        error: { name: "UnknownError", message },
      }), expect.objectContaining({ outcome: "failure" }));
    } finally {
      await app.dispose();
    }
  });
});
