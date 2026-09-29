/** Stable application-defined capability understood by authorization policies. */
export interface PermissionDefinition {
  readonly id: string;
  readonly description?: string;
}

/** Inspectable permission expression evaluated by the authorization manager. */
export type AuthorizationRequirement =
  | {
      readonly type: "permission";
      readonly permission: PermissionDefinition;
    }
  | {
      readonly type: "all";
      readonly requirements: readonly AuthorizationRequirement[];
    }
  | {
      readonly type: "any";
      readonly requirements: readonly AuthorizationRequirement[];
    };

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly requirement: AuthorizationRequirement;
  readonly reason: "granted" | "missing-permission";
}

/** Storage-neutral source of a subject's current effective permissions. */
export interface PermissionResolver {
  resolvePermissions(subjectId: string): Promise<ReadonlySet<string>>;
}

export type AuthorizationRoleState = "active" | "disabled";

/** Persisted role metadata used by management operations. */
export interface AuthorizationRole {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly state: AuthorizationRoleState;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RoleDefinition {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly permissions: readonly PermissionDefinition[];
}

/** Management port kept separate from permission resolution. */
export interface RoleStore {
  findRoleByKey(key: string): Promise<AuthorizationRole | undefined>;
}

/** Assigns and removes roles without exposing adapter internals to the app. */
export interface SubjectRoleStore {
  grantRole(
    subjectId: string,
    roleId: string,
    grantedBySubjectId?: string,
  ): Promise<boolean>;
  revokeRole(subjectId: string, roleId: string): Promise<boolean>;
}
