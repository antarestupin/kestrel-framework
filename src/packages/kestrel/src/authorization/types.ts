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

/** Application-owned role whose meaning is versioned with the code. */
export interface RoleDefinition {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly permissions: readonly PermissionDefinition[];
}

/** Persists assignments only; role definitions belong to the application code. */
export interface SubjectRoleStore {
  listRoleKeys(subjectId: string): Promise<ReadonlySet<string>>;
  grantRole(
    subjectId: string,
    roleKey: string,
    grantedBySubjectId?: string,
  ): Promise<boolean>;
  revokeRole(subjectId: string, roleKey: string): Promise<boolean>;
}
