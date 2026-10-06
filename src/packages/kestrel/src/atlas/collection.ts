import { z } from "zod";

import type { CollectionQuery } from "../db/index.js";
import type {
  AtlasCollectionQuery,
  AtlasFieldManifest,
} from "./contract.js";

export const atlasFilterOperatorSchema = z.enum([
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

/** Validates the source-independent collection request at the gateway. */
export const atlasCollectionQuerySchema = z.object({
  pagination: z.object({
    type: z.literal("page"),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
  }),
  search: z.string().optional(),
  filters: z.array(z.object({
    field: z.string().min(1),
    operator: atlasFilterOperatorSchema,
    value: z.unknown().optional(),
  })).optional(),
  sorting: z.array(z.object({
    field: z.string().min(1),
    direction: z.enum(["asc", "desc"]),
  })).optional(),
});

/** Restricts a collection schema to capabilities published by one Resource. */
export function createResourceCollectionQuerySchema(
  fields: readonly AtlasFieldManifest[],
  constraints?: {
    readonly firstPageOnly?: boolean;
    readonly maximumPageSize?: number;
    readonly minimumSearchLength?: number;
  },
) {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));

  return atlasCollectionQuerySchema.superRefine((query, context) => {
    if (constraints?.firstPageOnly === true && query.pagination.page !== 1) {
      context.addIssue({
        code: "custom",
        message: "This collection exposure only supports its first page.",
        path: ["pagination", "page"],
      });
    }

    if (
      constraints?.maximumPageSize !== undefined
      && query.pagination.pageSize > constraints.maximumPageSize
    ) {
      context.addIssue({
        code: "custom",
        message: `This collection exposure supports at most ${constraints.maximumPageSize} records per page.`,
        path: ["pagination", "pageSize"],
      });
    }

    if (
      constraints?.minimumSearchLength !== undefined
      && (query.search?.trim().length ?? 0) < constraints.minimumSearchLength
    ) {
      context.addIssue({
        code: "custom",
        message: `This collection exposure requires at least ${constraints.minimumSearchLength} search characters.`,
        path: ["search"],
      });
    }

    if (
      query.search !== undefined
      && !fields.some((field) => field.searchable)
    ) {
      context.addIssue({
        code: "custom",
        message: "This Resource does not support search.",
        path: ["search"],
      });
    }

    for (const [index, filter] of (query.filters ?? []).entries()) {
      const field = fieldsById.get(filter.field);
      if (field === undefined || !field.filterOperators.includes(filter.operator)) {
        context.addIssue({
          code: "custom",
          message: `Filter "${filter.field}.${filter.operator}" is not supported.`,
          path: ["filters", index],
        });
        continue;
      }

      const requiresValue = filter.operator !== "is-null"
        && filter.operator !== "is-not-null";
      if (requiresValue && filter.value === undefined) {
        context.addIssue({
          code: "custom",
          message: `Filter "${filter.field}.${filter.operator}" requires a value.`,
          path: ["filters", index, "value"],
        });
      }
      if (
        (filter.operator === "in" || filter.operator === "not-in")
        && (!Array.isArray(filter.value) || filter.value.length === 0)
      ) {
        context.addIssue({
          code: "custom",
          message: `Filter "${filter.field}.${filter.operator}" requires a non-empty array.`,
          path: ["filters", index, "value"],
        });
      }
    }

    const sortedFields = new Set<string>();
    for (const [index, sort] of (query.sorting ?? []).entries()) {
      if (fieldsById.get(sort.field)?.sortable !== true) {
        context.addIssue({
          code: "custom",
          message: `Sorting by "${sort.field}" is not supported.`,
          path: ["sorting", index],
        });
      } else if (sortedFields.has(sort.field)) {
        context.addIssue({
          code: "custom",
          message: `Sorting field "${sort.field}" is duplicated.`,
          path: ["sorting", index],
        });
      }
      sortedFields.add(sort.field);
    }
  });
}

/** Maps the portable atlas shape to the catalog collection contract. */
export function mapAtlasCollectionQueryToCatalog(
  query: AtlasCollectionQuery,
): CollectionQuery {
  return {
    pagination: query.pagination,
    ...(query.search === undefined || query.search === ""
      ? {}
      : { search: { term: query.search } }),
    ...(query.filters === undefined ? {} : { filters: query.filters }),
    ...(query.sorting === undefined ? {} : { sort: query.sorting }),
  };
}
