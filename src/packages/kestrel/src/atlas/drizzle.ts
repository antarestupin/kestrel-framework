import {
  getTableColumns,
  type Column,
} from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import type {
  AtlasFieldOptions,
} from "./resource.js";
import type { AtlasFieldKind } from "./contract.js";

/** Field overrides accepted by the Drizzle metadata helper. */
export type DrizzleAtlasFieldOverrides<
  DrizzleTable extends AnyPgTable,
> = Partial<{
  readonly [Field in keyof DrizzleTable["_"]["columns"] & string]:
    AtlasFieldOptions;
}>;

/** Field metadata generated for every property exposed by a Drizzle table. */
export type DrizzleAtlasFields<DrizzleTable extends AnyPgTable> = {
  readonly [Field in keyof DrizzleTable["_"]["columns"] & string]:
    AtlasFieldOptions;
};

/**
 * Derives portable atlas field metadata from public Drizzle columns.
 *
 * Relations remain explicit because a database foreign key cannot identify a
 * source-independent Atlas Resource. Explicit field overrides always win.
 */
export function defineDrizzleAtlasFields<DrizzleTable extends AnyPgTable>(
  table: DrizzleTable,
  overrides: DrizzleAtlasFieldOverrides<DrizzleTable> = {},
): DrizzleAtlasFields<DrizzleTable> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([id, column]) => {
      const override = overrides[id as keyof typeof overrides];

      // A relation override owns the kind so inferred scalar metadata cannot
      // conflict with the portable relation contract.
      if (override?.relation !== undefined) {
        return [id, { ...override }];
      }

      return [id, {
        kind: inferDrizzleFieldKind(column),
        ...override,
      }];
    }),
  ) as DrizzleAtlasFields<DrizzleTable>;
}

/** Maps Drizzle's stable column metadata to the standard renderer families. */
function inferDrizzleFieldKind(column: Column): AtlasFieldKind {
  if (column.primary) {
    return "id";
  }

  if (column.columnType === "PgDate" || column.columnType === "PgDateString") {
    return "date";
  }

  if (column.columnType.startsWith("PgTimestamp")) {
    return "datetime";
  }

  switch (column.dataType) {
    case "boolean":
      return "boolean";
    case "date":
      return "datetime";
    case "number":
      return "number";
    case "string":
      return "text";
    default:
      // Arrays, JSON, bigint and custom values require a specialized renderer
      // or an explicit override before they can be edited safely.
      return "json";
  }
}
