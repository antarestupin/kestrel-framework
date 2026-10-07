import type { Provider, ProviderCompositionApp } from "../../../app/index.js";
import type { RoleDefinition, SubjectRoleStore } from "../../types.js";
import { RolePermissionResolver, snapshotRoles } from "./resolver.js";

/** Composes the code-defined policy with the application's assignment store. */
export class RolePermissionResolverProvider<Config> implements Provider<Config> {
  private readonly roles: readonly RoleDefinition[];

  public constructor(roles: readonly RoleDefinition[]) {
    // Reject ambiguous catalogs during composition and retain a stable snapshot.
    this.roles = snapshotRoles(roles);
  }

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "permissionResolver",
      ({ subjectRoleStore }: { readonly subjectRoleStore: SubjectRoleStore }) =>
        new RolePermissionResolver({ roles: this.roles, subjectRoleStore }),
      { lifetime: "scoped" },
    );
  }
}
