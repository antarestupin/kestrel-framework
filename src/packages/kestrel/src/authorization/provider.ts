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
  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "authorizationManager",
      (dependencies: AuthorizationProviderDependencies) =>
        new AuthorizationManager(dependencies),
      { lifetime: "scoped" },
    );
  }
}
