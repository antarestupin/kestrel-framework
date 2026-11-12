import type { AuthenticationConfig } from "../../configuration.js";
import { createAuthenticationProof } from "../../proof.js";
import type { AccountStorageAdapter, PasswordCredentialStorageAdapter } from "../../stores.js";
import type {
  PasswordAuthenticationResult,
  PasswordCredentialsInput,
  PasswordHasher,
  UsernameNormalizer,
} from "./types.js";

export interface PasswordMechanismDependencies {
  readonly accountStore?: Pick<AccountStorageAdapter, "findById">;
  readonly credentialStore: PasswordCredentialStorageAdapter;
  readonly passwordHasher: PasswordHasher;
  readonly usernameNormalizer: UsernameNormalizer;
}

export interface PasswordMechanismOptions {
  readonly now?: () => Date;
}

/** Verifies password credentials and emits an opaque trusted proof. */
export class PasswordMechanism {
  private readonly now: () => Date;

  public constructor(
    private readonly dependencies: PasswordMechanismDependencies,
    private readonly config: AuthenticationConfig,
    options: PasswordMechanismOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public async authenticate(
    input: PasswordCredentialsInput,
  ): Promise<PasswordAuthenticationResult> {
    if (input.password.length > this.config.mechanisms.password.maxLength) {
      // Oversized inputs still perform one expensive verification. The minimum
      // is a creation policy: verification must keep legacy credentials usable.
      await this.dependencies.passwordHasher.verify(
        input.password.slice(0, this.config.mechanisms.password.maxLength),
        await this.dependencies.passwordHasher.getDummyHash(),
      );
      return { status: "rejected" };
    }

    const normalizedUsername = this.dependencies.usernameNormalizer.normalize(
      input.username,
    );
    const credential = await this.dependencies.credentialStore
      .findByNormalizedUsername(normalizedUsername);
    const hash = credential?.passwordHash
      ?? await this.dependencies.passwordHasher.getDummyHash();
    const verified = await this.dependencies.passwordHasher.verify(
      input.password,
      hash,
    );

    if (!verified || credential === undefined) {
      return { status: "rejected" };
    }

    let currentCredential = credential;
    let securityVersion: number | undefined;
    if (this.dependencies.accountStore !== undefined) {
      // Read the account version before confirming the credential so a reset cannot pair
      // a stale hash with the version of the new password.
      const account = await this.dependencies.accountStore.findById(credential.accountId);
      if (account?.state !== "active") {
        return { status: "rejected" };
      }
      securityVersion = account.securityVersion;
      const current = await this.dependencies.credentialStore.findByNormalizedUsername(normalizedUsername);
      if (
        current?.id !== credential.id
        || current.accountId !== credential.accountId
        || (current.passwordHash !== hash && !await this.dependencies.passwordHasher.verify(input.password, current.passwordHash))
      ) {
        return { status: "rejected" };
      }
      currentCredential = current;
    }

    if (this.dependencies.passwordHasher.needsRehash(currentCredential.passwordHash)) {
      const changedAt = this.now();
      const passwordHash = await this.dependencies.passwordHasher.hash(
        input.password,
      );
      await this.dependencies.credentialStore.replaceHash({
        id: currentCredential.id,
        previousHash: currentCredential.passwordHash,
        passwordHash,
        changedAt,
      });
    }

    const authenticatedAt = this.now();

    return {
      status: "verified",
      proof: createAuthenticationProof(currentCredential.accountId, {
        method: "password",
        factors: ["knowledge"],
        authenticatedAt,
      }, securityVersion),
    };
  }
}
