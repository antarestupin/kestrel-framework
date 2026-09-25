import { z } from "zod";

import { createPaginationCursorCodec } from "../utils/cursor_codec.js";

/** Shared by adapters and transport validation; ordering keys never depend on a live row. */
export const workflowExecutionCursorCodec = createPaginationCursorCodec(z.object({
  createdAt: z.iso.datetime({ precision: 6 }),
  id: z.string().min(1),
}));

/** Keeps the adapter's existing invalid-cursor error contract. */
export function decodeWorkflowExecutionCursor(token: string) {
  const result = workflowExecutionCursorCodec.safeParse(token);
  if (!result.success) {
    throw new TypeError("Workflow execution cursor is invalid.");
  }
  return result.data;
}

/** Native memory timestamps have millisecond precision, padded to the shared format. */
export function formatWorkflowCursorDate(date: Date): string {
  return date.toISOString().replace(/Z$/u, "000Z");
}
