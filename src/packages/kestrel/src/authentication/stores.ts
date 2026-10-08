import type {
  AuthenticationAccount,
  AuthenticationAccountState,
  AuthenticationEvidence,
} from "./types.js";

export interface CreateAuthenticationAccount {
  readonly subjectId: string;
  /** Defaults to active when the surrounding workflow needs no activation step. */
  readonly state?: AuthenticationAccountState;
}

export interface SetAuthenticationAccountState {
  readonly accountId: string;
  readonly state: AuthenticationAccountState;
}

/** Persistent account capability required by the authentication manager. */
export interface AccountStorageAdapter {
  findById(id: string): Promise<AuthenticationAccount | undefined>;
  findBySubjectId(
    subjectId: string,
  ): Promise<AuthenticationAccount | undefined>;
  createAccount(
    input: CreateAuthenticationAccount,
  ): Promise<AuthenticationAccount>;
  setState(
    input: SetAuthenticationAccountState,
  ): Promise<AuthenticationAccount | undefined>;
  incrementSecurityVersion(accountId: string): Promise<number | undefined>;
}

export interface StoredSession<Claims = unknown> {
  readonly id: string;
  readonly accountId: string;
  readonly tokenDigest: Uint8Array;
  readonly claims: Claims;
  readonly accountSecurityVersion: number;
  readonly evidence: AuthenticationEvidence;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt?: Date;
  readonly revokeReason?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

/** Session and current account state resolved from one storage snapshot. */
export interface ResolvedSessionAccount<Claims = unknown> {
  readonly session: StoredSession<Claims>;
  readonly account: AuthenticationAccount;
}

/** Optional adapter optimization for stores that colocate sessions and accounts. */
export interface SessionAccountResolver<Claims = unknown> {
  findSessionAndAccountByTokenDigest(
    tokenDigest: Uint8Array,
  ): Promise<ResolvedSessionAccount<Claims> | undefined>;
}

export type CreateStoredSession<Claims> = StoredSession<Claims>;

export interface TouchStoredSession {
  readonly id: string;
  readonly lastSeenAt: Date;
  readonly idleExpiresAt: Date;
  readonly now: Date;
}

export interface RevokeStoredSession {
  readonly id: string;
  readonly revokedAt: Date;
  readonly reason: string;
}

export interface RevokeAccountSessions {
  readonly accountId: string;
  readonly revokedAt: Date;
  readonly reason: string;
}

/** Persistent session capability with conditional lifecycle mutations. */
export interface SessionStorageAdapter<Claims = unknown> {
  createSession(
    input: CreateStoredSession<Claims>,
  ): Promise<StoredSession<Claims>>;
  findByTokenDigest(
    tokenDigest: Uint8Array,
  ): Promise<StoredSession<Claims> | undefined>;
  touch(input: TouchStoredSession): Promise<StoredSession<Claims> | undefined>;
  revoke(input: RevokeStoredSession): Promise<boolean>;
  revokeAllForAccount(input: RevokeAccountSessions): Promise<number>;
  listForAccount(accountId: string): Promise<readonly StoredSession<Claims>[]>;
}

export interface PasswordCredential {
  readonly id: string;
  readonly accountId: string;
  readonly username: string;
  readonly normalizedUsername: string;
  readonly passwordHash: string;
  readonly passwordChangedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreatePasswordCredential {
  readonly accountId: string;
  readonly username: string;
  readonly normalizedUsername: string;
  readonly passwordHash: string;
}

export interface ReplacePasswordHash {
  readonly id: string;
  readonly previousHash: string;
  readonly passwordHash: string;
  readonly changedAt: Date;
}

/** Password-specific storage kept out of the generic account contract. */
export interface PasswordCredentialStorageAdapter {
  findByNormalizedUsername(
    normalizedUsername: string,
  ): Promise<PasswordCredential | undefined>;
  createPasswordCredential(
    input: CreatePasswordCredential,
  ): Promise<PasswordCredential>;
  replaceHash(input: ReplacePasswordHash): Promise<boolean>;
}

/** Capabilities implemented together by the bundled adapters. */
export interface AuthenticationAdapter<Claims = unknown>
  extends AccountStorageAdapter,
    SessionStorageAdapter<Claims>,
    PasswordCredentialStorageAdapter {}
