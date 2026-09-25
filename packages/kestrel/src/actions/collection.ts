import { z } from "zod";

import { createPaginationInputSchema } from "./pagination.js";

export const collectionFilterOperatorSchema = z.enum([
  "contains",
  "equals",
  "greater-than",
  "greater-than-or-equal",
  "in",
  "is-not-null",
  "is-null",
  "less-than",
  "less-than-or-equal",
  "not-equals",
  "not-in",
  "starts-with",
]);

/** Creates the conventional collection input used by catalog Actions. */
export function createCollectionQueryInputSchema() {
  const searchSchema = z.object({
    term: z.string(),
  });
  const filterSchema = z.object({
    field: z.string().min(1),
    operator: collectionFilterOperatorSchema,
    value: z.unknown().optional(),
  });
  const filtersSchema = z.array(filterSchema);
  const sortCriterionSchema = z.object({
    field: z.string().min(1),
    direction: z.enum(["asc", "desc"]),
  });
  const sortSchema = z.array(sortCriterionSchema);

  return z.object({
    pagination: createPaginationInputSchema(),
    // JSON query strings keep the same Action usable through HTTP and CLI
    // controllers without coupling its business contract to either transport.
    search: z.union([
      searchSchema,
      jsonStringSchema(searchSchema),
    ]).optional(),
    filters: z.union([
      filtersSchema,
      jsonStringSchema(filtersSchema),
      z.array(jsonStringSchema(filterSchema)),
    ]).optional(),
    sort: z.union([
      sortSchema,
      jsonStringSchema(sortSchema),
      z.array(jsonStringSchema(sortCriterionSchema)),
    ]).optional(),
  });
}

function jsonStringSchema<Schema extends z.ZodType>(schema: Schema) {
  return z.string().transform((value, context): unknown => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({
        code: "custom",
        message: "Expected valid JSON.",
      });

      return z.NEVER;
    }
  }).pipe(schema);
}
