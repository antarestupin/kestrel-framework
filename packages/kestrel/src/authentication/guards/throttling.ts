import { createHmac } from "node:crypto";

import type { Provider, ProviderCompositionApp } from "../../app/index.js";
import {
  defineRateLimit,
  seconds,
  type Throttling,
  ThrottlingRejectedError,
} from "../../throttling/index.js";
import type {
  AuthenticationAttemptGuard,
  AuthenticationAttemptInput,
} from "../attempt_guard.js";
import { AuthenticationRateLimitedError } from "../errors.js";
import type { UsernameNormalizer } from "../mechanisms/password/index.js";

export interface AuthenticationRateLimitOptions {
  readonly requests: number;
  readonly perSeconds: number;
  readonly burst?: number;
}

export interface AuthenticationThrottlingOptions {
  readonly keySecret: string | Uint8Array;
  readonly username?: AuthenticationRateLimitOptions;
  readonly ip?: AuthenticationRateLimitOptions;
}

interface AuthenticationThrottlingDependencies {
  readonly throttling: Throttling;
  readonly usernameNormalizer: UsernameNormalizer;
}

/** Applies independent privacy-preserving username and IP rate limits. */
export class AuthenticationThrottlingGuard
  implements AuthenticationAttemptGuard
{
  private readonly usernameLimit;

  private readonly ipLimit;

  private readonly keySecret: string | Uint8Array;

  public constructor(
    private readonly dependencies: AuthenticationThrottlingDependencies,
    options: AuthenticationThrottlingOptions,
  ) {
    this.keySecret = options.keySecret;
    validateKeySecret(options.keySecret);
    this.usernameLimit = createLimit(
      "authentication.password.username",
      options.username ?? { requests: 5, perSeconds: 300 },
    );
    this.ipLimit = createLimit(
      "authentication.password.ip",
      options.ip ?? { requests: 30, perSeconds: 60 },
    );
  }

  public async run<Value>(
    input: AuthenticationAttemptInput,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const username = this.dependencies.usernameNormalizer.normalize(
      input.credentials.username,
    );
    const usernameKey = this.digest(`username:${username}`);
    const ipAddress = input.metadata?.ipAddress;

    try {
      return await this.dependencies.throttling.run(
        this.usernameLimit,
        { rateKey: usernameKey },
        () => ipAddress === undefined
          ? operation()
          : this.dependencies.throttling.run(
              this.ipLimit,
              { rateKey: this.digest(`ip:${ipAddress}`) },
              operation,
            ),
      );
    } catch (error: unknown) {
      if (error instanceof ThrottlingRejectedError) {
        throw new AuthenticationRateLimitedError();
      }

      throw error;
    }
  }

  private digest(value: string): string {
    return createHmac("sha256", this.keySecret).update(value).digest("hex");
  }
}

/** Replaces the default attempt guard with the throttling integration. */
export class AuthenticationThrottlingProvider<Config>
  implements Provider<Config>
{
  public constructor(
    private readonly options: AuthenticationThrottlingOptions,
  ) {}

  public register(app: ProviderCompositionApp<Config>): void {
    app.container.registerFactory(
      "authenticationAttemptGuard",
      (dependencies: AuthenticationThrottlingDependencies) =>
        new AuthenticationThrottlingGuard(dependencies, this.options),
      { lifetime: "scoped" },
    );
  }
}

function createLimit(id: string, options: AuthenticationRateLimitOptions) {
  return defineRateLimit({
    id,
    requests: options.requests,
    per: seconds(options.perSeconds),
    ...(options.burst === undefined ? {} : { burst: options.burst }),
  });
}

function validateKeySecret(value: string | Uint8Array): void {
  const length = typeof value === "string"
    ? Buffer.byteLength(value)
    : value.byteLength;

  if (length < 32) {
    throw new TypeError(
      "Authentication throttling key secrets must contain at least 32 bytes.",
    );
  }
}
