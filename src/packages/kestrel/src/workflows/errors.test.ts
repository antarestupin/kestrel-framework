import { describe, expect, it } from "vitest";

import {
  WorkflowActivityInfrastructureError,
  WorkflowActivityTimeoutError,
  WorkflowCancellationError,
  WorkflowConcurrencyConflictError,
  WorkflowDeploymentVersionError,
  WorkflowExecutionCancelledError,
  WorkflowExecutionClosedError,
  WorkflowExecutionConflictError,
  WorkflowExecutionFailedError,
  WorkflowExecutionNotFoundError,
  WorkflowExecutionTerminatedError,
  WorkflowExecutionVersionUnsupportedError,
  WorkflowHistoryLimitExceededError,
  WorkflowInvalidSuspensionError,
  WorkflowJournalConflictError,
  WorkflowNondeterminismError,
  WorkflowSignalConflictError,
  WorkflowSignalTimeoutError,
  serializeWorkflowError,
} from "./errors.js";

describe("durable workflow failure metadata", () => {
  it.each([
    ["WorkflowActivityTimeoutError", new WorkflowActivityTimeoutError("execution-1", 2, "start-to-close"), { executionId: "execution-1", sequence: 2, timeoutKind: "start-to-close" }],
    ["WorkflowSignalTimeoutError", new WorkflowSignalTimeoutError("execution-1", "approved"), { executionId: "execution-1", signalName: "approved" }],
    ["WorkflowCancellationError", new WorkflowCancellationError("execution-1"), { executionId: "execution-1" }],
  ] as const)("retains the replay discriminator and fields for %s", (name, error, details) => {
    delete error.stack;
    expect(serializeWorkflowError(error)).toStrictEqual({ name, message: expect.stringContaining("execution-1"), details });
  });

  it("bounds error stacks while preserving infrastructure retry metadata", () => {
    const cause = new Error("connection reset");
    const error = new WorkflowActivityInfrastructureError("retryable failure", { cause });
    error.stack = "0123456789";
    expect(error.cause).toBe(cause);
    expect(serializeWorkflowError(error, 4)).toStrictEqual({ name: "WorkflowActivityInfrastructureError", message: "retryable failure", stack: "0123" });
    error.stack = "x".repeat(8_001);
    expect(serializeWorkflowError(error).stack).toHaveLength(8_000);
  });

  it("persists printable arbitrary values without manufacturing a stack", () => {
    expect(serializeWorkflowError(undefined)).toStrictEqual({ name: "Error", message: "undefined" });
    expect(serializeWorkflowError(42)).toStrictEqual({ name: "Error", message: "42" });
  });

  it("can persist failures even if inspecting the thrown value raises another error", () => {
    const withoutPrimitiveConversion = Object.create(null);
    const withInvalidStack = new Error("original failure");
    Object.defineProperty(withInvalidStack, "stack", { get() { throw new Error("stack getter failed"); } });
    for (const thrown of [withoutPrimitiveConversion, withInvalidStack]) {
      expect(serializeWorkflowError(thrown)).toStrictEqual({ name: "Error", message: expect.stringMatching(/\S/u) });
    }
  });
});

describe("workflow error diagnostics", () => {
  it.each([
    ["WorkflowExecutionNotFoundError", new WorkflowExecutionNotFoundError("missing-run"), "missing-run"],
    ["WorkflowExecutionConflictError", new WorkflowExecutionConflictError("existing-run"), "existing-run"],
    ["WorkflowConcurrencyConflictError", new WorkflowConcurrencyConflictError("process.order", "order-42"), "order-42"],
    ["WorkflowExecutionClosedError", new WorkflowExecutionClosedError("closed-run"), "closed-run"],
    ["WorkflowSignalConflictError", new WorkflowSignalConflictError("signal-run", "signal-key"), "signal-key"],
    ["WorkflowExecutionFailedError", new WorkflowExecutionFailedError("failed-run", { name: "Error", message: "declined" }), "declined"],
    ["WorkflowExecutionCancelledError", new WorkflowExecutionCancelledError("cancelled-run"), "cancelled-run"],
    ["WorkflowExecutionTerminatedError", new WorkflowExecutionTerminatedError("terminated-run", "maintenance"), "maintenance"],
    ["WorkflowExecutionVersionUnsupportedError", new WorkflowExecutionVersionUnsupportedError("version-run", 1, 2, 3), "version-run"],
    ["WorkflowJournalConflictError", new WorkflowJournalConflictError("journal-run", 2, 3), "journal-run"],
    ["WorkflowInvalidSuspensionError", new WorkflowInvalidSuspensionError("suspended-run"), "suspended-run"],
    ["WorkflowHistoryLimitExceededError", new WorkflowHistoryLimitExceededError("large-run", 200, 100), "large-run"],
  ] as const)("retains the stable name and diagnostic context for %s", (name, error, fragment) => {
    expect(error).toMatchObject({ name, message: expect.stringContaining(fragment) });
  });

  it("reports version incompatibilities with each deployed definition and reason", () => {
    const diagnostics = [
      { workflowName: "first.flow", workflowVersion: 1, count: 2, reason: "definition-missing" },
      { workflowName: "second.flow", workflowVersion: 3, count: 5, reason: "version-unsupported" },
    ] as const;
    const error = new WorkflowDeploymentVersionError(diagnostics);
    expect(error).toMatchObject({ name: "WorkflowDeploymentVersionError", diagnostics });
    expect(error.message).toContain("first.flow@1 (2: definition-missing)");
    expect(error.message).toContain("second.flow@3 (5: version-unsupported)");
  });

  it("distinguishes a missing command from a changed command identity in replay diagnostics", () => {
    const missing = new WorkflowNondeterminismError("replay-run", 1, "activity", "expected");
    expect(missing.message).toContain("received no command");
    const changed = new WorkflowNondeterminismError("replay-run", 1, "activity", "expected", "signal", "changed");
    expect(changed.message).toContain("expected activity:expected, received signal:changed");
    const missingTarget = new WorkflowNondeterminismError("replay-run", 1, "activity", "expected", "signal");
    expect(missingTarget.message).toMatch(/received signal:\W*$/u);
  });
});
