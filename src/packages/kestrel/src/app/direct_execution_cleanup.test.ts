import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineAction } from "../actions/index.js";
import { App, executionCompletedEvent } from "./index.js";
import { executionCompletedObservation, executionStartedObservation } from "./observations.js";

describe("direct execution cleanup", () => {
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

  it("observes an undefined rejection as a failure with its original value", async () => {
    const app = new App({});
    const record = vi.fn();
    app.container.registerValue("observer", { record });
    const action = defineAction({
      name: "example.reject",
      input: z.null(),
      output: z.null(),
      handler: () => Promise.reject(undefined),
    });

    try {
      await expect(app.get(action).run(null)).rejects.toBeUndefined();
      // The failure outcome, rather than the value of the rejection, selects error diagnostics.
      expect(record).toHaveBeenCalledWith(executionCompletedObservation, expect.objectContaining({
        error: { name: "UnknownError", message: "undefined" },
      }), expect.objectContaining({ outcome: "failure" }));
    } finally {
      await app.dispose();
    }
  });
});
