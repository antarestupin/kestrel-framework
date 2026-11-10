import { describe, expect, it } from "vitest";

import { serializeScheduledTaskError } from "./types.js";

describe("scheduled task persisted errors", () => {
  it("retains error identity fields and bounds stack size", () => {
    const error = new TypeError("Task failed");
    error.stack = "0123456789";
    expect(serializeScheduledTaskError(error, 4)).toEqual({ name: "TypeError", message: "Task failed", stack: "0123" });
    expect(error.stack).toBe("0123456789");
    expect(serializeScheduledTaskError(error, 0).stack).toBe("");
    error.stack = "x".repeat(8_001);
    expect(serializeScheduledTaskError(error).stack).toHaveLength(8_000);
  });

  it("omits absent stacks and converts arbitrary thrown values", () => {
    const error = new Error("No stack");
    delete error.stack;
    expect(serializeScheduledTaskError(error)).toEqual({ name: "Error", message: "No stack" });
    for (const value of ["failure", 42, null, undefined]) {
      expect(serializeScheduledTaskError(value)).toEqual({ name: "Error", message: String(value) });
    }
  });
});
