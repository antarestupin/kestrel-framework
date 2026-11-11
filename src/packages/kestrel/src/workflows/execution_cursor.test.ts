import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { decodeWorkflowExecutionCursor, formatWorkflowCursorDate, workflowExecutionCursorCodec } from "./execution_cursor.js";

describe("workflow execution cursor", () => {
  it("preserves PostgreSQL microseconds and pads native Date milliseconds", () => {
    const cursor = { id: "stable-execution", createdAt: "2026-01-01T00:00:00.012345Z" };
    expect(decodeWorkflowExecutionCursor(workflowExecutionCursorCodec.encode(cursor))).toEqual(cursor);
    expect(formatWorkflowCursorDate(new Date(cursor.createdAt))).toBe("2026-01-01T00:00:00.012000Z");
  });

  it.each([
    { id: "stable-execution", createdAt: "2026-01-01T00:00:00.012Z" },
    { id: "", createdAt: "2026-01-01T00:00:00.012345Z" },
  ])("rejects incompatible durable cursor data (%j)", (cursor) => {
    const token = Buffer.from(JSON.stringify({ version: 1, value: cursor })).toString("base64url");
    expect(() => decodeWorkflowExecutionCursor(token)).toThrow(TypeError);
  });
});
