import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  defineDatabaseSchemaDescription,
  defineDatabaseTableDescriptions,
} from "../../../db/schema_contributions/descriptions.js";

/** Isolates authorization persistence from authentication and application data. */
export const authorizationSqlSchema = defineDatabaseSchemaDescription(
  pgSchema("authorization"),
  "Roles, permissions, and application-subject role grants.",
);

export const authorizationRoles = authorizationSqlSchema.table(
  "role",
  {
    id: uuid("id").default(sql`uuidv7()`).primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    state: text("state").default("active").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("authorization_role_key_unique").on(table.key),
    check(
      "authorization_role_state_check",
      sql`${table.state} in ('active', 'disabled')`,
    ),
  ],
);

defineDatabaseTableDescriptions(authorizationRoles, {
  description: "Named roles that group permissions and can be enabled or disabled.",
  columns: {
    id: "Stable identifier of the role.",
    key: "Stable machine-readable key used to reference the role.",
    name: "Human-readable role name.",
    description: "Optional human-readable explanation of the role's purpose.",
    state: "Role state controlling whether its grants are effective.",
    createdAt: "Date and time when the role was created.",
    updatedAt: "Date and time when the role was last updated.",
  },
});

export const authorizationRolePermissions = authorizationSqlSchema.table(
  "role_permission",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => authorizationRoles.id, { onDelete: "cascade" }),
    permissionId: text("permission_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
    index("authorization_role_permission_permission_idx")
      .on(table.permissionId),
  ],
);

defineDatabaseTableDescriptions(authorizationRolePermissions, {
  description: "Permissions assigned to roles.",
  columns: {
    roleId: "Role receiving the permission.",
    permissionId: "Stable application-defined permission identifier.",
  },
});

export const authorizationSubjectRoles = authorizationSqlSchema.table(
  "subject_role",
  {
    // Text preserves the application-owned subject identifier contract.
    subjectId: text("subject_id").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => authorizationRoles.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    grantedBySubjectId: text("granted_by_subject_id"),
  },
  (table) => [
    primaryKey({ columns: [table.subjectId, table.roleId] }),
    index("authorization_subject_role_role_idx").on(table.roleId),
  ],
);

defineDatabaseTableDescriptions(authorizationSubjectRoles, {
  description: "Role grants assigned to opaque application-owned subjects.",
  columns: {
    subjectId: "Opaque application-owned identifier of the subject receiving the role.",
    roleId: "Role granted to the subject.",
    grantedAt: "Date and time when the role was granted.",
    grantedBySubjectId: "Optional application-owned identifier of the subject that issued the grant.",
  },
});

/** Default Kestrel-owned Drizzle mapping. */
export const authorizationTables = {
  roles: authorizationRoles,
  rolePermissions: authorizationRolePermissions,
  subjectRoles: authorizationSubjectRoles,
};
