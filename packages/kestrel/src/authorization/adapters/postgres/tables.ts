import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";

type StringColumn = AnyPgColumn<{ data: string; notNull: true }>;
type NullableStringColumn = AnyPgColumn<{ data: string; notNull: false }>;
type DateColumn = AnyPgColumn<{ data: Date; notNull: true }>;

export type PostgresAuthorizationRoleTable = AnyPgTable & {
  id: StringColumn;
  key: StringColumn;
  name: StringColumn;
  description: NullableStringColumn;
  state: StringColumn;
  createdAt: DateColumn;
  updatedAt: DateColumn;
};

export type PostgresAuthorizationRolePermissionTable = AnyPgTable & {
  roleId: StringColumn;
  permissionId: StringColumn;
};

export type PostgresAuthorizationSubjectRoleTable = AnyPgTable & {
  subjectId: StringColumn;
  roleId: StringColumn;
  grantedAt: DateColumn;
  grantedBySubjectId: NullableStringColumn;
};

export interface PostgresAuthorizationTables {
  readonly roles: PostgresAuthorizationRoleTable;
  readonly rolePermissions: PostgresAuthorizationRolePermissionTable;
  readonly subjectRoles: PostgresAuthorizationSubjectRoleTable;
}
