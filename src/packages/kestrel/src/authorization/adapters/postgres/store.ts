import { and, eq } from "drizzle-orm";

import type { PostgresDrizzleManager } from "../../../db/index.js";
import type { SubjectRoleStorageAdapter } from "../../types.js";
import { authorizationTables } from "./schema.js";
import type { PostgresAuthorizationTables } from "./tables.js";

/** Stores role assignments without persisting or resolving role definitions. */
export class PostgresSubjectRoleStorageAdapter implements SubjectRoleStorageAdapter {
  public constructor(
    private readonly databaseManager: PostgresDrizzleManager,
    private readonly tables: PostgresAuthorizationTables = authorizationTables,
  ) {}

  public async listRoleKeys(subjectId: string): Promise<ReadonlySet<string>> {
    const rows = await this.database
      .select({ roleKey: this.tables.subjectRoles.roleKey })
      .from(this.tables.subjectRoles)
      .where(eq(this.tables.subjectRoles.subjectId, subjectId));
    return new Set(rows.map(({ roleKey }) => roleKey));
  }

  public async grantRole(
    subjectId: string,
    roleKey: string,
    grantedBySubjectId?: string,
  ): Promise<boolean> {
    // The composite key makes repeated and concurrent grants idempotent.
    const inserted = await this.database
      .insert(this.tables.subjectRoles)
      .values({
        subjectId,
        roleKey,
        ...(grantedBySubjectId === undefined ? {} : { grantedBySubjectId }),
      })
      .onConflictDoNothing()
      .returning({ subjectId: this.tables.subjectRoles.subjectId });
    return inserted.length > 0;
  }

  public async revokeRole(subjectId: string, roleKey: string): Promise<boolean> {
    const deleted = await this.database
      .delete(this.tables.subjectRoles)
      .where(and(
        eq(this.tables.subjectRoles.subjectId, subjectId),
        eq(this.tables.subjectRoles.roleKey, roleKey),
      ))
      .returning({ subjectId: this.tables.subjectRoles.subjectId });
    return deleted.length > 0;
  }

  private get database(): PostgresDrizzleManager["database"] {
    return this.databaseManager.database;
  }
}
