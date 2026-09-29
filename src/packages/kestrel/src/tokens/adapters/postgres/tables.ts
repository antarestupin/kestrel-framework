import type {
  AnyPgColumn,
  AnyPgTable,
} from "drizzle-orm/pg-core";

type StringColumn = AnyPgColumn<{ data: string; notNull: true }>;
type NullableStringColumn = AnyPgColumn<{ data: string; notNull: false }>;
type BytesColumn = AnyPgColumn<{ data: Buffer; notNull: true }>;
type JsonColumn = AnyPgColumn<{ data: unknown; notNull: true }>;
type DateColumn = AnyPgColumn<{ data: Date; notNull: true }>;
type NullableDateColumn = AnyPgColumn<{ data: Date; notNull: false }>;
type BooleanColumn = AnyPgColumn<{ data: boolean; notNull: true }>;

/** Drizzle table shape accepted by the PostgreSQL token store. */
export type PostgresTokenTable = AnyPgTable & {
  id: StringColumn;
  definition: StringColumn;
  subject: NullableStringColumn;
  subjectExclusive: BooleanColumn;
  digest: BytesColumn;
  payload: JsonColumn;
  expiresAt: DateColumn;
  consumedAt: NullableDateColumn;
  revokedAt: NullableDateColumn;
  createdAt: DateColumn;
};
