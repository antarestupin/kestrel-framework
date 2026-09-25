import type { Provider, ProviderCompositionApp } from "../app/index.js";
import type { TokensConfig } from "./configuration.js";
import { TokenManager } from "./manager.js";
import { StoredTokenStrategy } from "./stored_strategy.js";
import type { TokenStore, TokenStrategy } from "./types.js";

interface TokenProviderDependencies {
  readonly tokenStore: TokenStore;
}

export interface TokenProviderOptions {
  /** Disables the bundled opaque strategy; factories may still require a store. */
  readonly stored?: boolean;
  /** Adds representation strategies such as a configured JWT strategy. */
  readonly strategies?: Readonly<Record<string, TokenStrategy>>;
  /** Builds stateful strategies such as hybrid JWTs from the configured store. */
  readonly strategyFactories?: Readonly<Record<
    string,
    (store: TokenStore) => TokenStrategy
  >>;
}

/** Registers the token facade and composes configured representation strategies. */
export class TokenProvider<Config> implements Provider<Config> {
  public constructor(
    protected readonly config: TokensConfig,
    protected readonly options: TokenProviderOptions = {},
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    const requiresStore = this.options.stored !== false
      || Object.keys(this.options.strategyFactories ?? {}).length > 0;

    if (!requiresStore) {
      app.container.registerFactory(
        "tokenManager",
        () => this.createManager(),
        { lifetime: "scoped" },
      );
    } else {
      app.container.registerFactory(
        "tokenManager",
        ({ tokenStore }: TokenProviderDependencies) =>
          this.createManager(tokenStore),
        { lifetime: "scoped" },
      );
    }
  }

  /** Allows applications to compose additional strategy instances. */
  protected createStrategies(
    tokenStore?: TokenStore,
  ): Readonly<Record<string, TokenStrategy>> {
    const stateful = tokenStore === undefined
      ? {}
      : Object.fromEntries(Object.entries(
        this.options.strategyFactories ?? {},
      ).map(([name, create]) => [name, create(tokenStore)]));

    return {
      ...(tokenStore === undefined
        ? {}
        : {
            stored: new StoredTokenStrategy(tokenStore, {
              tokenBytes: this.config.stored.tokenBytes,
            }),
          }),
      ...stateful,
      ...this.options.strategies,
    };
  }

  private createManager(tokenStore?: TokenStore): TokenManager {
    return new TokenManager(
      this.createStrategies(tokenStore),
      { maxPayloadBytes: this.config.stored.maxPayloadBytes },
    );
  }
}
