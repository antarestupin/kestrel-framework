import type { AuthenticationEvidence } from "./types.js";

/** Proof values remain structurally opaque outside trusted mechanisms. */
export interface AuthenticationProof {
  readonly accountId: string;
  readonly evidence: AuthenticationEvidence;
}

const trustedProofs = new WeakSet<object>();

/** Creates a proof after a mechanism has completed secret verification. */
export function createAuthenticationProof(
  accountId: string,
  evidence: AuthenticationEvidence,
): AuthenticationProof {
  const proof = Object.freeze({
    accountId,
    evidence: Object.freeze({
      ...evidence,
      factors: Object.freeze([...evidence.factors]),
    }),
  });

  trustedProofs.add(proof);
  return proof;
}

/** Rejects structurally similar objects that did not come from a mechanism. */
export function assertTrustedAuthenticationProof(
  proof: AuthenticationProof,
): void {
  if (!trustedProofs.has(proof)) {
    throw new TypeError("Authentication proof is not trusted.");
  }
}

