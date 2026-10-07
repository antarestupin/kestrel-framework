import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";

type StringColumn = AnyPgColumn<{ data: string; notNull: true }>;
type NullableStringColumn = AnyPgColumn<{ data: string; notNull: false }>;
type DateColumn = AnyPgColumn<{ data: Date; notNull: true }>;

export type PostgresAuthorizationSubjectRoleTable = AnyPgTable & {
  subjectId: StringColumn;
  roleKey: StringColumn;
  grantedAt: DateColumn;
  grantedBySubjectId: NullableStringColumn;
};

export interface PostgresAuthorizationTables {
  readonly subjectRoles: PostgresAuthorizationSubjectRoleTable;
}
