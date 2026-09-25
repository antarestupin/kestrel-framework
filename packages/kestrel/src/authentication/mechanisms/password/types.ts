import type { AuthenticationProof } from "../../proof.js";

export interface PasswordHasher {
  readonly id: string;
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string): Promise<boolean>;
  needsRehash(encodedHash: string): boolean;
  getDummyHash(): Promise<string>;
}

export interface UsernameNormalizer {
  normalize(username: string): string;
}

export interface PasswordCredentialsInput {
  readonly username: string;
  readonly password: string;
}

export type PasswordAuthenticationResult =
  | { readonly status: "rejected" }
  | { readonly status: "verified"; readonly proof: AuthenticationProof };

