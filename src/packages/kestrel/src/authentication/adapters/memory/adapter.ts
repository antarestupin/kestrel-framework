import { createUuid } from "../../../utils/uuid.js";
import type {
  AuthenticationAdapter,
  CreateAuthenticationAccount,
  CreatePasswordCredential,
  CreateStoredSession,
  PasswordCredential,
  ReplacePasswordHash,
  RevokeAccountSessions,
  RevokeStoredSession,
  SetAuthenticationAccountState,
  StoredSession,
  TouchStoredSession,
} from "../../stores.js";
import type { AuthenticationAccount } from "../../types.js";

export interface MemoryAuthenticationAdapterOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
}

/** Process-local adapter used by tests and explicit local compositions. */
export class MemoryAuthenticationAdapter<Claims = unknown>
  implements AuthenticationAdapter<Claims>
{
  private readonly accounts = new Map<string, AuthenticationAccount>();

  private readonly accountIdsBySubject = new Map<string, string>();

  private readonly credentials = new Map<string, PasswordCredential>();

  private readonly credentialIdsByUsername = new Map<string, string>();

  private readonly sessions = new Map<string, StoredSession<Claims>>();

  private readonly sessionIdsByDigest = new Map<string, string>();

  private readonly now: () => Date;

  private readonly createId: () => string;

  public constructor(options: MemoryAuthenticationAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? createUuid;
  }

  public async findById(
    id: string,
  ): Promise<AuthenticationAccount | undefined> {
    return cloneAccount(this.accounts.get(id));
  }

  public async findBySubjectId(
    subjectId: string,
  ): Promise<AuthenticationAccount | undefined> {
    const accountId = this.accountIdsBySubject.get(subjectId);

    return accountId === undefined
      ? undefined
      : this.findById(accountId);
  }

  public async createAccount(
    input: CreateAuthenticationAccount,
  ): Promise<AuthenticationAccount> {
    return this.insertAccount(input);
  }

  public async createPasswordCredential(
    input: CreatePasswordCredential,
  ): Promise<PasswordCredential> {
    return this.insertCredential(input);
  }

  public async createSession(
    input: CreateStoredSession<Claims>,
  ): Promise<StoredSession<Claims>> {
    return this.insertSession(input);
  }

  public async setState(
    input: SetAuthenticationAccountState,
  ): Promise<AuthenticationAccount | undefined> {
    const account = this.accounts.get(input.accountId);

    if (account === undefined) {
      return undefined;
    }

    const updated = {
      ...account,
      state: input.state,
      updatedAt: this.now(),
    };
    this.accounts.set(account.id, updated);

    return cloneAccount(updated);
  }

  public async incrementSecurityVersion(
    accountId: string,
  ): Promise<number | undefined> {
    const account = this.accounts.get(accountId);

    if (account === undefined) {
      return undefined;
    }

    const securityVersion = account.securityVersion + 1;
    this.accounts.set(accountId, {
      ...account,
      securityVersion,
      updatedAt: this.now(),
    });

    return securityVersion;
  }

  public async findByTokenDigest(
    tokenDigest: Uint8Array,
  ): Promise<StoredSession<Claims> | undefined> {
    const id = this.sessionIdsByDigest.get(digestKey(tokenDigest));

    return id === undefined
      ? undefined
      : cloneSession(this.sessions.get(id));
  }

  public async touch(
    input: TouchStoredSession,
  ): Promise<StoredSession<Claims> | undefined> {
    const session = this.sessions.get(input.id);

    if (
      session === undefined
      || session.revokedAt !== undefined
      || session.idleExpiresAt <= input.now
      || session.absoluteExpiresAt <= input.now
    ) {
      return undefined;
    }

    const updated = {
      ...session,
      lastSeenAt: input.lastSeenAt,
      idleExpiresAt: input.idleExpiresAt,
    };
    this.sessions.set(session.id, updated);

    return cloneSession(updated);
  }

  public async revoke(input: RevokeStoredSession): Promise<boolean> {
    const session = this.sessions.get(input.id);

    if (session === undefined || session.revokedAt !== undefined) {
      return false;
    }

    this.sessions.set(session.id, {
      ...session,
      revokedAt: input.revokedAt,
      revokeReason: input.reason,
    });
    return true;
  }

  public async revokeAllForAccount(
    input: RevokeAccountSessions,
  ): Promise<number> {
    let revoked = 0;

    for (const session of this.sessions.values()) {
      if (session.accountId === input.accountId && session.revokedAt === undefined) {
        this.sessions.set(session.id, {
          ...session,
          revokedAt: input.revokedAt,
          revokeReason: input.reason,
        });
        revoked += 1;
      }
    }

    return revoked;
  }

  public async listForAccount(
    accountId: string,
  ): Promise<readonly StoredSession<Claims>[]> {
    return [...this.sessions.values()]
      .filter((session) => session.accountId === accountId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map((session) => cloneSession(session)!);
  }

  public async findByNormalizedUsername(
    normalizedUsername: string,
  ): Promise<PasswordCredential | undefined> {
    const id = this.credentialIdsByUsername.get(normalizedUsername);

    return id === undefined
      ? undefined
      : cloneCredential(this.credentials.get(id));
  }

  public async replaceHash(input: ReplacePasswordHash): Promise<boolean> {
    const credential = this.credentials.get(input.id);

    if (
      credential === undefined
      || credential.passwordHash !== input.previousHash
    ) {
      return false;
    }

    this.credentials.set(credential.id, {
      ...credential,
      passwordHash: input.passwordHash,
      passwordChangedAt: input.changedAt,
      updatedAt: input.changedAt,
    });
    return true;
  }

  private insertAccount(
    input: CreateAuthenticationAccount,
  ): AuthenticationAccount {
    if (this.accountIdsBySubject.has(input.subjectId)) {
      throw new Error("An authentication account already exists for this subject.");
    }

    const now = this.now();
    const account: AuthenticationAccount = {
      id: this.createId(),
      subjectId: input.subjectId,
      state: input.state ?? "active",
      securityVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.accounts.set(account.id, account);
    this.accountIdsBySubject.set(account.subjectId, account.id);

    return cloneAccount(account)!;
  }

  private insertCredential(
    input: CreatePasswordCredential,
  ): PasswordCredential {
    if (!this.accounts.has(input.accountId)) {
      throw new Error("Password credential account does not exist.");
    }

    if (this.credentialIdsByUsername.has(input.normalizedUsername)) {
      throw new Error("Normalized usernames must be unique.");
    }

    const now = this.now();
    const credential: PasswordCredential = {
      id: this.createId(),
      ...input,
      passwordChangedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.credentials.set(credential.id, credential);
    this.credentialIdsByUsername.set(
      credential.normalizedUsername,
      credential.id,
    );

    return cloneCredential(credential)!;
  }

  private insertSession(
    input: CreateStoredSession<Claims>,
  ): StoredSession<Claims> {
    const key = digestKey(input.tokenDigest);

    if (this.sessions.has(input.id) || this.sessionIdsByDigest.has(key)) {
      throw new Error("Session identifiers and token digests must be unique.");
    }

    const session = cloneSession(input)!;
    this.sessions.set(session.id, session);
    this.sessionIdsByDigest.set(key, session.id);

    return cloneSession(session)!;
  }
}

function cloneAccount(
  account: AuthenticationAccount | undefined,
): AuthenticationAccount | undefined {
  return account === undefined
    ? undefined
    : {
        ...account,
        createdAt: new Date(account.createdAt),
        updatedAt: new Date(account.updatedAt),
      };
}

function cloneCredential(
  credential: PasswordCredential | undefined,
): PasswordCredential | undefined {
  return credential === undefined
    ? undefined
    : {
        ...credential,
        passwordChangedAt: new Date(credential.passwordChangedAt),
        createdAt: new Date(credential.createdAt),
        updatedAt: new Date(credential.updatedAt),
      };
}

function cloneSession<Claims>(
  session: StoredSession<Claims> | undefined,
): StoredSession<Claims> | undefined {
  return session === undefined
    ? undefined
    : {
        ...session,
        tokenDigest: Uint8Array.from(session.tokenDigest),
        evidence: {
          ...session.evidence,
          factors: [...session.evidence.factors],
          authenticatedAt: new Date(session.evidence.authenticatedAt),
        },
        createdAt: new Date(session.createdAt),
        lastSeenAt: new Date(session.lastSeenAt),
        idleExpiresAt: new Date(session.idleExpiresAt),
        absoluteExpiresAt: new Date(session.absoluteExpiresAt),
        ...(session.revokedAt === undefined
          ? {}
          : { revokedAt: new Date(session.revokedAt) }),
      };
}

function digestKey(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}
