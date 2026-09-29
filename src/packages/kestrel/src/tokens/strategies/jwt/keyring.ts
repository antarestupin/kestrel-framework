import type { KeyInput } from "jose";

export type JwtTokenAlgorithm =
  | "EdDSA"
  | "Ed25519"
  | "ES256"
  | "ES384"
  | "ES512"
  | "HS256"
  | "HS384"
  | "HS512"
  | "PS256"
  | "PS384"
  | "PS512"
  | "RS256"
  | "RS384"
  | "RS512";

const supportedAlgorithms = new Set<JwtTokenAlgorithm>([
  "EdDSA",
  "Ed25519",
  "ES256",
  "ES384",
  "ES512",
  "HS256",
  "HS384",
  "HS512",
  "PS256",
  "PS384",
  "PS512",
  "RS256",
  "RS384",
  "RS512",
]);

export interface JwtTokenKey {
  readonly id: string;
  readonly algorithm: JwtTokenAlgorithm;
  readonly key: KeyInput;
}

export interface JwtTokenKeyringOptions {
  /** Private key or symmetric secret used for every new signature. */
  readonly active: JwtTokenKey;
  /** Public keys or symmetric secrets accepted during verification. */
  readonly verification: readonly JwtTokenKey[];
}

/** Immutable signing and verification key selection with explicit rotation. */
export class JwtTokenKeyring {
  private readonly active: JwtTokenKey;

  private readonly verification = new Map<string, JwtTokenKey>();

  public constructor(options: JwtTokenKeyringOptions) {
    this.active = freezeKey(options.active);

    for (const key of options.verification) {
      validateKey(key);

      if (this.verification.has(key.id)) {
        throw new TypeError(
          `JWT verification key ID "${key.id}" is registered more than once.`,
        );
      }

      this.verification.set(key.id, freezeKey(key));
    }

    const activeVerifier = this.verification.get(this.active.id);

    if (activeVerifier === undefined) {
      throw new TypeError(
        `JWT active key ID "${this.active.id}" requires a verification key.`,
      );
    }
    if (activeVerifier.algorithm !== this.active.algorithm) {
      throw new TypeError(
        `JWT active key ID "${this.active.id}" must use the same signing and verification algorithm.`,
      );
    }
  }

  public getActive(): JwtTokenKey {
    return this.active;
  }

  /** Resolves only an exact key-ID and algorithm pair. */
  public resolve(
    id: string | undefined,
    algorithm: string | undefined,
  ): JwtTokenKey | undefined {
    if (id === undefined || algorithm === undefined) return undefined;
    const key = this.verification.get(id);

    return key?.algorithm === algorithm ? key : undefined;
  }
}

function freezeKey(key: JwtTokenKey): JwtTokenKey {
  validateKey(key);

  return Object.freeze({ ...key });
}

function validateKey(key: JwtTokenKey): void {
  if (key.id.trim().length === 0 || key.id.length > 128) {
    throw new TypeError(
      "JWT key IDs must be non-empty and at most 128 characters.",
    );
  }
  if (!supportedAlgorithms.has(key.algorithm)) {
    throw new TypeError(
      `JWT algorithm "${key.algorithm}" is not supported.`,
    );
  }
  if (key.key === undefined || key.key === null) {
    throw new TypeError(`JWT key ID "${key.id}" requires key material.`);
  }
}
