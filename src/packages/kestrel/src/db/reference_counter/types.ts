import type { SQL } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";

export interface ReferenceCounterOptions<Source extends AnyPgTable> {
  readonly id: string;
  readonly reference: Source["_"]["columns"][keyof Source["_"]["columns"]];
  /** A single-column primary key; its values must remain immutable. */
  readonly target: AnyPgColumn;
  /** A dedicated NOT NULL integer/bigint column with a zero default. */
  readonly counter: AnyPgColumn;
  /** A deterministic SQL predicate over the supplied source columns only. */
  readonly where?: (row: Source["_"]["columns"]) => SQL | undefined;
}

export interface ReferenceCounterDefinition {
  readonly id: string;
  readonly source: AnyPgTable;
  readonly reference: AnyPgColumn;
  readonly target: AnyPgColumn;
  readonly counter: AnyPgColumn;
  /** Compiled once so trigger and maintenance predicates cannot diverge. */
  readonly predicates: Readonly<Record<"old" | "new" | "source", string>>;
}

