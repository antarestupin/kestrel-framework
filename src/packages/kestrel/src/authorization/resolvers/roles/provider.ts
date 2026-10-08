import { registerScopedAdapter } from "../../../di/adapter.js";
import type { SubjectRoleStorageAdapterDefinition } from "../../adapter_definition.js";
import type { Provider, ProviderCompositionApp } from "../../../app/index.js";
import type { RoleDefinition, SubjectRoleStorageAdapter } from "../../types.js";
import { RolePermissionResolver, snapshotRoles } from "./resolver.js";

/** Composes the code-defined policy with the application's assignment store. */
export class RolePermissionResolverProvider<Config> implements Provider<Config> {
  private readonly roles: readonly RoleDefinition[];

  public constructor(
    roles: readonly RoleDefinition[],
    private readonly adapter: SubjectRoleStorageAdapterDefinition,
  ) {
    // Reject ambiguous catalogs during composition and retain a stable snapshot.
    this.roles = snapshotRoles(roles);
  }

  public register(app: ProviderCompositionApp<Config>): void {
    registerScopedAdapter(app.container, "subjectRoleStore", this.adapter, undefined);
    app.container.registerFactory(
      "permissionResolver",
      ({ subjectRoleStore }: { readonly subjectRoleStore: SubjectRoleStorageAdapter }) =>
        new RolePermissionResolver({ roles: this.roles, subjectRoleStore }),
      { lifetime: "scoped" },
    );
  }
}
