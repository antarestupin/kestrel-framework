import {
  index,
  pgSchema,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import {
  defineDatabaseSchemaDescription,
  defineDatabaseTableDescriptions,
} from "../../../db/schema_contributions/descriptions.js";

/** Isolates authorization persistence from authentication and application data. */
export const authorizationSqlSchema = defineDatabaseSchemaDescription(
  pgSchema("authorization"),
  "Application-subject assignments of code-defined roles.",
);

export const authorizationSubjectRoles = authorizationSqlSchema.table(
  "subject_role",
  {
    // Text preserves the application-owned subject identifier contract.
    subjectId: text("subject_id").notNull(),
    // No foreign key: the application catalog owns the stable role key.
    roleKey: text("role_key").notNull(),
    grantedAt: timestamp("granted_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    grantedBySubjectId: text("granted_by_subject_id"),
  },
  (table) => [
    primaryKey({ columns: [table.subjectId, table.roleKey] }),
    index("authorization_subject_role_role_idx").on(table.roleKey),
  ],
);

defineDatabaseTableDescriptions(authorizationSubjectRoles, {
  description: "Role grants assigned to opaque application-owned subjects.",
  columns: {
    subjectId: "Opaque application-owned identifier of the subject receiving the role.",
    roleKey: "Stable key of the code-defined role granted to the subject.",
    grantedAt: "Date and time when the role was granted.",
    grantedBySubjectId: "Optional application-owned identifier of the subject that issued the grant.",
  },
});

/** Default Kestrel-owned Drizzle mapping. */
export const authorizationTables = {
  subjectRoles: authorizationSubjectRoles,
};
