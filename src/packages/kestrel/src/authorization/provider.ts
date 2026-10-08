import { registerScopedAdapter } from "../di/adapter.js";
import type { PermissionResolverAdapterDefinition } from "./resolver_definition.js";
import type { Provider, ProviderCompositionApp } from "../app/index.js";
import type { AuthenticationContext } from "../authentication/index.js";
import { AuthorizationManager } from "./manager.js";
import type { PermissionResolver } from "./types.js";

interface AuthorizationProviderDependencies {
  readonly authenticationContext: AuthenticationContext<unknown>;
  readonly permissionResolver: PermissionResolver;
}

/** Registers storage-neutral, execution-scoped authorization services. */
export class AuthorizationProvider<Config> implements Provider<Config> {
  public constructor(private readonly adapter: PermissionResolverAdapterDefinition) {}

  public register(app: ProviderCompositionApp<Config>): void {
    registerScopedAdapter(app.container, "permissionResolver", this.adapter, undefined);
    app.container.registerFactory(
      "authorizationManager",
      (dependencies: AuthorizationProviderDependencies) => new AuthorizationManager(dependencies),
      { lifetime: "scoped" },
    );
  }
}
