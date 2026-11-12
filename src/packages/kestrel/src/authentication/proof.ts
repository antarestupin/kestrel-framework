import type { AuthenticationEvidence } from "./types.js";

/** Proof values remain structurally opaque outside trusted mechanisms. */
export interface AuthenticationProof {
  readonly accountId: string;
  readonly evidence: AuthenticationEvidence;
}

const trustedProofs = new WeakMap<AuthenticationProof, { readonly securityVersion: number | undefined }>();

/** Creates a proof after a mechanism has completed secret verification. */
export function createAuthenticationProof(
  accountId: string,
  evidence: AuthenticationEvidence,
  securityVersion?: number,
): AuthenticationProof {
  const proof = Object.freeze({
    accountId,
    evidence: Object.freeze({
      ...evidence,
      factors: Object.freeze([...evidence.factors]),
    }),
  });

  // The version belongs to the trusted proof, outside its public representation.
  trustedProofs.set(proof, { securityVersion });
  return proof;
}

/** Rejects structurally similar objects that did not come from a mechanism. */
export function trustedAuthenticationSecurityVersion(
  proof: AuthenticationProof,
): number | undefined {
  const snapshot = trustedProofs.get(proof);
  if (snapshot === undefined) {
    throw new TypeError("Authentication proof is not trusted.");
  }
  return snapshot.securityVersion;
}

