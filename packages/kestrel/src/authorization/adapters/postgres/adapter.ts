import { and, eq } from "drizzle-orm";

import type { DatabaseManager } from "../../../db/index.js";
import type {
  AuthorizationRole,
  PermissionResolver,
  RoleStore,
  SubjectRoleStore,
} from "../../types.js";
import type { PostgresAuthorizationTables } from "./tables.js";

/** PostgreSQL RBAC implementation behind storage-neutral core ports. */
export class PostgresAuthorizationAdapter
  implements PermissionResolver, RoleStore, SubjectRoleStore
{
  public constructor(
    private readonly databaseManager: DatabaseManager,
    private readonly tables: PostgresAuthorizationTables,
  ) {}

  public async resolvePermissions(
    subjectId: string,
  ): Promise<ReadonlySet<string>> {
    const rows = await this.database
      .select({ permissionId: this.tables.rolePermissions.permissionId })
      .from(this.tables.subjectRoles)
      .innerJoin(
        this.tables.roles,
        eq(this.tables.roles.id, this.tables.subjectRoles.roleId),
      )
      .innerJoin(
        this.tables.rolePermissions,
        eq(this.tables.rolePermissions.roleId, this.tables.roles.id),
      )
      .where(and(
        eq(this.tables.subjectRoles.subjectId, subjectId),
        eq(this.tables.roles.state, "active"),
      ));

    return new Set(rows.map((row) => row.permissionId));
  }

  public async findRoleByKey(
    key: string,
  ): Promise<AuthorizationRole | undefined> {
    const [role] = await this.database
      .select({
        id: this.tables.roles.id,
        key: this.tables.roles.key,
        name: this.tables.roles.name,
        description: this.tables.roles.description,
        state: this.tables.roles.state,
        createdAt: this.tables.roles.createdAt,
        updatedAt: this.tables.roles.updatedAt,
      })
      .from(this.tables.roles)
      .where(eq(this.tables.roles.key, key))
      .limit(1);

    if (role === undefined) {
      return undefined;
    }

    if (role.state !== "active" && role.state !== "disabled") {
      throw new Error(`Unsupported authorization role state: ${role.state}`);
    }

    return {
      id: role.id,
      key: role.key,
      name: role.name,
      ...(role.description === null ? {} : { description: role.description }),
      state: role.state,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    };
  }

  public async grantRole(
    subjectId: string,
    roleId: string,
    grantedBySubjectId?: string,
  ): Promise<boolean> {
    const inserted = await this.database
      .insert(this.tables.subjectRoles)
      .values({
        subjectId,
        roleId,
        ...(grantedBySubjectId === undefined
          ? {}
          : { grantedBySubjectId }),
      })
      .onConflictDoNothing()
      .returning({ subjectId: this.tables.subjectRoles.subjectId });

    return inserted.length > 0;
  }

  public async revokeRole(subjectId: string, roleId: string): Promise<boolean> {
    const deleted = await this.database
      .delete(this.tables.subjectRoles)
      .where(and(
        eq(this.tables.subjectRoles.subjectId, subjectId),
        eq(this.tables.subjectRoles.roleId, roleId),
      ))
      .returning({ subjectId: this.tables.subjectRoles.subjectId });

    return deleted.length > 0;
  }

  private get database(): DatabaseManager["database"] {
    return this.databaseManager.database;
  }
}
