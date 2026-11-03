import { z } from "zod";

/** Cursor strings preserve PostgreSQL bigint sequences across JSON transport. */
export const atlasHistoryInputSchema = z.object({
  id: z.string().min(1),
  before: z.string().regex(/^[1-9][0-9]*$/).max(19).refine((value) => /^[1-9][0-9]*$/.test(value) && value.length <= 19 && BigInt(value) <= 9223372036854775807n, "Invalid history cursor.").optional(),
  pageSize: z.number().int().min(1).max(100).default(20),
});

/** Sparse values contain only authorized fields changed by this event. */
export const atlasHistoryOutputSchema = z.object({
  fields: z.array(z.string()),
  events: z.array(z.object({
    sequence: z.string(),
    changedAt: z.string(),
    operation: z.enum(["insert", "update", "delete"]),
    actor: z.string().nullable(),
    reason: z.string().nullable(),
    values: z.record(z.string(), z.unknown()),
  })),
  nextCursor: z.string().nullable(),
});
export type AtlasHistoryPage = z.infer<typeof atlasHistoryOutputSchema>;
