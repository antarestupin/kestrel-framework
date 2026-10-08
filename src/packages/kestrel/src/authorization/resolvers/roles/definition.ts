import type { SubjectRoleStorageAdapterDefinition } from "../../adapter_definition.js";
import type { RoleDefinition } from "../../types.js";
import { RolePermissionResolver, snapshotRoles } from "./resolver.js";

/** Composes code-defined roles with execution-local assignment storage. */
export function rolePermissions(
  roles: readonly RoleDefinition[],
  storage: SubjectRoleStorageAdapterDefinition,
) {
  const snapshot = snapshotRoles(roles);
  // The composed value owns its child storage and closes it with its scope.
  const owned = new WeakMap<RolePermissionResolver, ReturnType<typeof storage.create>>();
  return {
    capabilities: {},
    create: (resolve: Parameters<typeof storage.create>[0]) => {
      const subjectRoleStore = storage.create(resolve, undefined);
      const resolver = new RolePermissionResolver({ roles: snapshot, subjectRoleStore });
      owned.set(resolver, subjectRoleStore);
      return resolver;
    },
    dispose: (resolver: RolePermissionResolver) => {
      const value = owned.get(resolver);
      owned.delete(resolver);
      return value === undefined ? undefined : storage.dispose?.(value);
    },
  };
}
