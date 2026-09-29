import type { PasswordCredentialsInput } from "./mechanisms/password/index.js";
import type { AuthenticationAttemptMetadata } from "./manager.js";

export interface AuthenticationAttemptInput {
  readonly credentials: PasswordCredentialsInput;
  readonly metadata?: AuthenticationAttemptMetadata;
}

/** Security admission boundary that cannot manufacture a successful proof. */
export interface AuthenticationAttemptGuard {
  run<Value>(
    input: AuthenticationAttemptInput,
    operation: () => Promise<Value>,
  ): Promise<Value>;
}

/** Default guard used when the application deliberately selects no controls. */
export class AllowAuthenticationAttemptGuard
  implements AuthenticationAttemptGuard
{
  public run<Value>(
    _input: AuthenticationAttemptInput,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    return operation();
  }
}

