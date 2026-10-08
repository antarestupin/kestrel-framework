import { defineRole } from "../../definition.js";
import type { PermissionResolver, RoleDefinition, SubjectRoleStorageAdapter } from "../../types.js";

export interface RolePermissionResolverOptions {
  readonly roles: readonly RoleDefinition[];
  readonly subjectRoleStore: SubjectRoleStorageAdapter;
}

/** Resolves live assignments against an immutable, code-defined role catalog. */
export class RolePermissionResolver implements PermissionResolver {
  private readonly permissionsByRole = new Map<string, readonly string[]>();
  private readonly subjectRoleStore: SubjectRoleStorageAdapter;

  public constructor(options: RolePermissionResolverOptions) {
    this.subjectRoleStore = options.subjectRoleStore;
    for (const role of snapshotRoles(options.roles)) {
      this.permissionsByRole.set(role.key, role.permissions.map(({ id }) => id));
    }
  }

  public async resolvePermissions(subjectId: string): Promise<ReadonlySet<string>> {
    const roleKeys = await this.subjectRoleStore.listRoleKeys(subjectId);
    const permissions = new Set<string>();
    for (const key of roleKeys) {
      // Removed or unknown roles remain inert, including during rolling deployments.
      for (const id of this.permissionsByRole.get(key) ?? []) {
        permissions.add(id);
      }
    }
    return permissions;
  }
}

/** Validate and detach configuration before any execution can evaluate it. */
export function snapshotRoles(roles: readonly RoleDefinition[]): readonly RoleDefinition[] {
  const keys = new Set<string>();
  return Object.freeze(roles.map((definition) => {
    const role = defineRole(definition);
    if (keys.has(role.key)) {
      throw new TypeError(`Authorization role "${role.key}" is declared more than once.`);
    }
    keys.add(role.key);
    return role;
  }));
}
