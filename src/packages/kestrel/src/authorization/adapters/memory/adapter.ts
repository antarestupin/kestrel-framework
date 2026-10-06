import { uuidV7 } from "../../../utils/uuid.js";
import type {
  AuthorizationRole,
  PermissionResolver,
  RoleDefinition,
  RoleStore,
  SubjectRoleStore,
} from "../../types.js";

export interface MemoryAuthorizationAdapterOptions {
  readonly roles?: readonly RoleDefinition[];
  readonly now?: () => Date;
  readonly createId?: () => string;
}

/** Process-local RBAC adapter intended for tests and explicit local setups. */
export class MemoryAuthorizationAdapter
  implements PermissionResolver, RoleStore, SubjectRoleStore
{
  private readonly rolesById = new Map<string, AuthorizationRole>();
  private readonly roleIdsByKey = new Map<string, string>();
  private readonly permissionIdsByRole = new Map<string, ReadonlySet<string>>();
  private readonly roleIdsBySubject = new Map<string, Set<string>>();
  private readonly now: () => Date;
  private readonly createId: () => string;

  public constructor(options: MemoryAuthorizationAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? uuidV7;

    for (const role of options.roles ?? []) {
      this.addRole(role);
    }
  }

  public addRole(definition: RoleDefinition): AuthorizationRole {
    if (this.roleIdsByKey.has(definition.key)) {
      throw new Error(`Authorization role "${definition.key}" already exists.`);
    }

    const now = this.now();
    const role = Object.freeze({
      id: this.createId(),
      key: definition.key,
      name: definition.name,
      ...(definition.description === undefined
        ? {}
        : { description: definition.description }),
      state: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    this.rolesById.set(role.id, role);
    this.roleIdsByKey.set(role.key, role.id);
    this.permissionIdsByRole.set(
      role.id,
      new Set(definition.permissions.map((permission) => permission.id)),
    );
    return role;
  }

  public async resolvePermissions(
    subjectId: string,
  ): Promise<ReadonlySet<string>> {
    const permissions = new Set<string>();

    for (const roleId of this.roleIdsBySubject.get(subjectId) ?? []) {
      const role = this.rolesById.get(roleId);

      if (role?.state !== "active") {
        continue;
      }

      for (const permissionId of this.permissionIdsByRole.get(roleId) ?? []) {
        permissions.add(permissionId);
      }
    }

    return permissions;
  }

  public async findRoleByKey(
    key: string,
  ): Promise<AuthorizationRole | undefined> {
    const id = this.roleIdsByKey.get(key);
    return id === undefined ? undefined : this.rolesById.get(id);
  }

  public async grantRole(subjectId: string, roleId: string): Promise<boolean> {
    if (!this.rolesById.has(roleId)) {
      throw new Error(`Unknown authorization role id "${roleId}".`);
    }

    const roleIds = this.roleIdsBySubject.get(subjectId) ?? new Set<string>();
    const before = roleIds.size;
    roleIds.add(roleId);
    this.roleIdsBySubject.set(subjectId, roleIds);
    return roleIds.size > before;
  }

  public async revokeRole(subjectId: string, roleId: string): Promise<boolean> {
    return this.roleIdsBySubject.get(subjectId)?.delete(roleId) ?? false;
  }
}
