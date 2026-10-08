import { registerScopedAdapter } from "../di/adapter.js";
import type { AuthenticationAdapterDefinition } from "./adapter_definition.js";
import type { Provider, ProviderBootApp, ProviderCompositionApp } from "../app/index.js";
import type { AuthenticationConfig } from "./configuration.js";
import { AllowAuthenticationAttemptGuard } from "./attempt_guard.js";
import { AuthenticationContext } from "./context.js";
import type { AuthenticationDefinition } from "./definition.js";
import { AuthenticationManager } from "./manager.js";
import { PasswordMechanism } from "./mechanisms/password/mechanism.js";
import { DefaultUsernameNormalizer } from "./mechanisms/password/normalization.js";
import type { PasswordHasher } from "./mechanisms/password/types.js";
import type {
  AccountStorageAdapter,
  AuthenticationAdapter,
  PasswordCredentialStorageAdapter,
  SessionStorageAdapter,
} from "./stores.js";
import type { AuthenticationSubject, SubjectProvider } from "./types.js";

interface AuthenticationProviderDependencies<Subject extends AuthenticationSubject, Claims> {
  accountStore: AccountStorageAdapter;
  sessionStore: SessionStorageAdapter<Claims>;
  authenticationSubjectProvider: SubjectProvider<Subject>;
}

interface PasswordMechanismProviderDependencies {
  passwordCredentialStore: PasswordCredentialStorageAdapter;
  passwordHasher: PasswordHasher;
  usernameNormalizer: DefaultUsernameNormalizer;
}

/** Registers storage-neutral authentication services over a selected adapter. */
export class AuthenticationProvider<
  Config,
  Subject extends AuthenticationSubject,
  Claims,
> implements Provider<Config> {
  public constructor(
    protected readonly config: AuthenticationConfig,
    private readonly adapter: AuthenticationAdapterDefinition<Claims>,
    protected readonly definition: AuthenticationDefinition<Subject, Claims>,
    protected readonly passwordHasher: PasswordHasher,
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    if (!app.container.hasRegistration("authenticationAttemptGuard")) {
      app.container.registerClass("authenticationAttemptGuard", AllowAuthenticationAttemptGuard, {
        lifetime: "scoped",
      });
    }

    app.container.registerValue("passwordHasher", this.passwordHasher);
    app.container.registerValue("usernameNormalizer", new DefaultUsernameNormalizer());
    app.container.registerFactory(
      "authenticationContext",
      () => new AuthenticationContext<Claims>(),
      { lifetime: "scoped" },
    );
    registerScopedAdapter(app.container, "authenticationAdapter", this.adapter, undefined);
    this.registerAdapterFallbacks(app);
    app.container.registerFactory(
      "passwordMechanism",
      (dependencies: PasswordMechanismProviderDependencies) =>
        new PasswordMechanism(
          {
            credentialStore: dependencies.passwordCredentialStore,
            passwordHasher: dependencies.passwordHasher,
            usernameNormalizer: dependencies.usernameNormalizer,
          },
          this.config,
        ),
      { lifetime: "scoped" },
    );
    app.container.registerFactory(
      "authenticationManager",
      (dependencies: AuthenticationProviderDependencies<Subject, Claims>) =>
        new AuthenticationManager(
          {
            accountStore: dependencies.accountStore,
            sessionStore: dependencies.sessionStore,
            subjectProvider: dependencies.authenticationSubjectProvider,
          },
          this.config,
          this.definition,
        ),
      { lifetime: "scoped" },
    );
  }

  /** Prepares the stable dummy hash before the first missing-user attempt. */
  public async boot(app: ProviderBootApp<Config>): Promise<void> {
    if (app.bootPlan.runningMode === "minimal") {
      return;
    }

    await this.passwordHasher.getDummyHash();
  }

  /** Uses a combined adapter only for capabilities not supplied independently. */
  private registerAdapterFallbacks(app: ProviderCompositionApp<Config>): void {
    const registerFallback = (name: string) => {
      if (!app.container.hasRegistration(name)) {
        app.container.registerFactory(
          name,
          ({ authenticationAdapter }: { authenticationAdapter: AuthenticationAdapter<Claims> }) =>
            authenticationAdapter,
          { lifetime: "scoped" },
        );
      }
    };

    registerFallback("accountStore");
    registerFallback("sessionStore");
    registerFallback("passwordCredentialStore");
  }
}
