import type { TokenDefinition } from "./definition.js";

export interface TokenGrant {
  /** Bearer value returned only when the token is issued. */
  readonly token: string;
  readonly expiresAt: Date;
}

export type TokenExpiry =
  | { readonly expiresAt: Date; readonly ttlSeconds?: never }
  | { readonly expiresAt?: never; readonly ttlSeconds: number };

export type IssueTokenOptions = TokenExpiry;

export interface TokenResolution {
  readonly payload: unknown;
  readonly expiresAt: Date;
}

export interface TokenPruneOptions {
  /** Removes tokens expired at or before this instant. */
  readonly expiredBefore: Date;
  /** Removes consumed or revoked tokens inactive at or before this instant. */
  readonly inactiveBefore: Date;
  readonly limit: number;
}

export interface TokenStrategyCapabilities {
  readonly pruning: boolean;
  readonly revocation: boolean;
  readonly singleUse: boolean;
  readonly subjectDeletion: boolean;
}

/** Representation-specific token behavior selected by a definition. */
export interface TokenStrategy {
  readonly capabilities: TokenStrategyCapabilities;
  /** Deduplicates pruning when several strategies share one state store. */
  readonly pruningScope?: object;
  issue<Payload>(
    definition: TokenDefinition<Payload>,
    payloads: readonly Payload[],
    options: IssueTokenOptions,
  ): Promise<readonly TokenGrant[]>;
  verify<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<TokenResolution | undefined>;
  consume?<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<TokenResolution | undefined>;
  revoke?<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<boolean>;
  revokeForSubject?<Payload>(
    definition: TokenDefinition<Payload>,
    subject: string,
  ): Promise<number>;
  deleteForSubject?<Payload>(
    definition: TokenDefinition<Payload>,
    subject: string,
  ): Promise<number>;
  prune?(options: TokenPruneOptions): Promise<number>;
}

export interface StoredToken {
  readonly id: string;
  readonly definition: string;
  readonly subject?: string;
  readonly digest: Uint8Array;
  readonly payload: unknown;
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
  readonly revokedAt?: Date;
  readonly createdAt: Date;
}

export interface CreateStoredToken extends StoredToken {
  readonly replaceExistingForSubject: boolean;
}

export interface StoredTokenLookup {
  readonly definition: string;
  readonly digest: Uint8Array;
  readonly now: Date;
}

export interface StoredTokenRevocation extends StoredTokenLookup {
  readonly revokedAt: Date;
}

export interface StoredTokenSubjectMutation {
  readonly definition: string;
  readonly subject: string;
  readonly now: Date;
}

/** Persistence boundary shared by opaque and hybrid stateful strategies. */
export interface TokenStorageAdapter {
  /** Creates the complete batch atomically after applying replacements. */
  createMany(tokens: readonly CreateStoredToken[]): Promise<void>;
  findValid(input: StoredTokenLookup): Promise<StoredToken | undefined>;
  /** Atomically consumes a valid token and returns its stored snapshot. */
  consume(input: StoredTokenLookup): Promise<StoredToken | undefined>;
  revoke(input: StoredTokenRevocation): Promise<boolean>;
  revokeForSubject(input: StoredTokenSubjectMutation): Promise<number>;
  deleteForSubject(input: StoredTokenSubjectMutation): Promise<number>;
  prune(options: TokenPruneOptions): Promise<number>;
}
