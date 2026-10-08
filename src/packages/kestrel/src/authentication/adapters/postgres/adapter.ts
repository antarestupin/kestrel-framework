import {
  and,
  desc,
  eq,
  gt,
  isNull,
  sql,
} from "drizzle-orm";

import type { PostgresDrizzleManager } from "../../../db/index.js";
import type {
  AuthenticationAdapter,
  CreateAuthenticationAccount,
  CreatePasswordCredential,
  CreateStoredSession,
  PasswordCredential,
  ReplacePasswordHash,
  ResolvedSessionAccount,
  RevokeAccountSessions,
  RevokeStoredSession,
  SetAuthenticationAccountState,
  SessionAccountResolver,
  StoredSession,
  TouchStoredSession,
} from "../../stores.js";
import type { AuthenticationAccount } from "../../types.js";
import type { PostgresAuthenticationTables } from "./tables.js";

/** Authentication persistence over application-supplied Drizzle tables. */
export class PostgresAuthenticationAdapter<Claims = unknown>
  implements AuthenticationAdapter<Claims>, SessionAccountResolver<Claims>
{
  public constructor(
    private readonly databaseManager: PostgresDrizzleManager,
    private readonly tables: PostgresAuthenticationTables,
  ) {}

  public async findById(
    id: string,
  ): Promise<AuthenticationAccount | undefined> {
    const [account] = await this.database
      .select(accountSelection(this.tables))
      .from(this.tables.accounts)
      .where(eq(this.tables.accounts.id, id))
      .limit(1);

    return account === undefined ? undefined : mapAccount(account);
  }

  public async findBySubjectId(
    subjectId: string,
  ): Promise<AuthenticationAccount | undefined> {
    const [account] = await this.database
      .select(accountSelection(this.tables))
      .from(this.tables.accounts)
      .where(eq(this.tables.accounts.subjectId, subjectId))
      .limit(1);

    return account === undefined ? undefined : mapAccount(account);
  }

  public async createAccount(
    input: CreateAuthenticationAccount,
  ): Promise<AuthenticationAccount> {
    const [account] = await this.database
      .insert(this.tables.accounts)
      .values({
        subjectId: input.subjectId,
        ...(input.state === undefined ? {} : { state: input.state }),
      })
      .returning(accountSelection(this.tables));

    if (account === undefined) {
      throw new Error("PostgreSQL did not return the created account.");
    }

    return mapAccount(account);
  }

  public async setState(
    input: SetAuthenticationAccountState,
  ): Promise<AuthenticationAccount | undefined> {
    const [account] = await this.database
      .update(this.tables.accounts)
      .set({
        state: input.state,
        securityVersion: sql`${this.tables.accounts.securityVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(this.tables.accounts.id, input.accountId))
      .returning(accountSelection(this.tables));

    return account === undefined ? undefined : mapAccount(account);
  }

  public async incrementSecurityVersion(
    accountId: string,
  ): Promise<number | undefined> {
    const [account] = await this.database
      .update(this.tables.accounts)
      .set({
        securityVersion: sql`${this.tables.accounts.securityVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(this.tables.accounts.id, accountId))
      .returning({ securityVersion: this.tables.accounts.securityVersion });

    return account?.securityVersion;
  }

  public async createSession(
    input: CreateStoredSession<Claims>,
  ): Promise<StoredSession<Claims>> {
    const [session] = await this.database
      .insert(this.tables.sessions)
      .values({
        id: input.id,
        accountId: input.accountId,
        tokenDigest: Buffer.from(input.tokenDigest),
        claims: input.claims,
        accountSecurityVersion: input.accountSecurityVersion,
        authenticationMethod: input.evidence.method,
        authenticationFactors: [...input.evidence.factors],
        authenticatedAt: input.evidence.authenticatedAt,
        createdAt: input.createdAt,
        lastSeenAt: input.lastSeenAt,
        idleExpiresAt: input.idleExpiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      })
      .returning(sessionSelection(this.tables));

    if (session === undefined) {
      throw new Error("PostgreSQL did not return the created session.");
    }

    return mapSession<Claims>(session);
  }

  public async findByTokenDigest(
    tokenDigest: Uint8Array,
  ): Promise<StoredSession<Claims> | undefined> {
    const [session] = await this.database
      .select(sessionSelection(this.tables))
      .from(this.tables.sessions)
      .where(eq(this.tables.sessions.tokenDigest, Buffer.from(tokenDigest)))
      .limit(1);

    return session === undefined ? undefined : mapSession<Claims>(session);
  }

  /** Resolves colocated session and account state with one PostgreSQL query. */
  public async findSessionAndAccountByTokenDigest(
    tokenDigest: Uint8Array,
  ): Promise<ResolvedSessionAccount<Claims> | undefined> {
    const [resolution] = await this.database
      .select({
        session: sessionSelection(this.tables),
        account: accountSelection(this.tables),
      })
      .from(this.tables.sessions)
      .innerJoin(
        this.tables.accounts,
        eq(this.tables.accounts.id, this.tables.sessions.accountId),
      )
      .where(eq(this.tables.sessions.tokenDigest, Buffer.from(tokenDigest)))
      .limit(1);

    return resolution === undefined
      ? undefined
      : {
          session: mapSession<Claims>(resolution.session),
          account: mapAccount(resolution.account),
        };
  }

  public async touch(
    input: TouchStoredSession,
  ): Promise<StoredSession<Claims> | undefined> {
    const [session] = await this.database
      .update(this.tables.sessions)
      .set({
        lastSeenAt: input.lastSeenAt,
        idleExpiresAt: input.idleExpiresAt,
      })
      .where(and(
        eq(this.tables.sessions.id, input.id),
        isNull(this.tables.sessions.revokedAt),
        gt(this.tables.sessions.idleExpiresAt, input.now),
        gt(this.tables.sessions.absoluteExpiresAt, input.now),
      ))
      .returning(sessionSelection(this.tables));

    return session === undefined ? undefined : mapSession<Claims>(session);
  }

  public async revoke(input: RevokeStoredSession): Promise<boolean> {
    const revoked = await this.database
      .update(this.tables.sessions)
      .set({
        revokedAt: input.revokedAt,
        revokeReason: input.reason,
      })
      .where(and(
        eq(this.tables.sessions.id, input.id),
        isNull(this.tables.sessions.revokedAt),
      ))
      .returning({ id: this.tables.sessions.id });

    return revoked.length > 0;
  }

  public async revokeAllForAccount(
    input: RevokeAccountSessions,
  ): Promise<number> {
    const revoked = await this.database
      .update(this.tables.sessions)
      .set({
        revokedAt: input.revokedAt,
        revokeReason: input.reason,
      })
      .where(and(
        eq(this.tables.sessions.accountId, input.accountId),
        isNull(this.tables.sessions.revokedAt),
      ))
      .returning({ id: this.tables.sessions.id });

    return revoked.length;
  }

  public async listForAccount(
    accountId: string,
  ): Promise<readonly StoredSession<Claims>[]> {
    const sessions = await this.database
      .select(sessionSelection(this.tables))
      .from(this.tables.sessions)
      .where(eq(this.tables.sessions.accountId, accountId))
      .orderBy(desc(this.tables.sessions.createdAt));

    return sessions.map((session) => mapSession<Claims>(session));
  }

  public async findByNormalizedUsername(
    normalizedUsername: string,
  ): Promise<PasswordCredential | undefined> {
    const [credential] = await this.database
      .select(passwordCredentialSelection(this.tables))
      .from(this.tables.passwordCredentials)
      .where(eq(
        this.tables.passwordCredentials.normalizedUsername,
        normalizedUsername,
      ))
      .limit(1);

    return credential;
  }

  public async createPasswordCredential(
    input: CreatePasswordCredential,
  ): Promise<PasswordCredential> {
    const [credential] = await this.database
      .insert(this.tables.passwordCredentials)
      .values(input)
      .returning(passwordCredentialSelection(this.tables));

    if (credential === undefined) {
      throw new Error("PostgreSQL did not return the created credential.");
    }

    return credential;
  }

  public async replaceHash(input: ReplacePasswordHash): Promise<boolean> {
    const replaced = await this.database
      .update(this.tables.passwordCredentials)
      .set({
        passwordHash: input.passwordHash,
        passwordChangedAt: input.changedAt,
        updatedAt: input.changedAt,
      })
      .where(and(
        eq(this.tables.passwordCredentials.id, input.id),
        eq(this.tables.passwordCredentials.passwordHash, input.previousHash),
      ))
      .returning({ id: this.tables.passwordCredentials.id });

    return replaced.length > 0;
  }

  private get database(): PostgresDrizzleManager["database"] {
    return this.databaseManager.database;
  }
}

function accountSelection(tables: PostgresAuthenticationTables) {
  return {
    id: tables.accounts.id,
    subjectId: tables.accounts.subjectId,
    state: tables.accounts.state,
    securityVersion: tables.accounts.securityVersion,
    createdAt: tables.accounts.createdAt,
    updatedAt: tables.accounts.updatedAt,
  };
}

function mapAccount(account: {
  id: string;
  subjectId: string;
  state: string;
  securityVersion: number;
  createdAt: Date;
  updatedAt: Date;
}): AuthenticationAccount {
  if (account.state !== "active" && account.state !== "disabled") {
    throw new Error(`Unsupported authentication account state: ${account.state}`);
  }

  return { ...account, state: account.state };
}

function passwordCredentialSelection(tables: PostgresAuthenticationTables) {
  return {
    id: tables.passwordCredentials.id,
    accountId: tables.passwordCredentials.accountId,
    username: tables.passwordCredentials.username,
    normalizedUsername: tables.passwordCredentials.normalizedUsername,
    passwordHash: tables.passwordCredentials.passwordHash,
    passwordChangedAt: tables.passwordCredentials.passwordChangedAt,
    createdAt: tables.passwordCredentials.createdAt,
    updatedAt: tables.passwordCredentials.updatedAt,
  };
}

function sessionSelection(tables: PostgresAuthenticationTables) {
  return {
    id: tables.sessions.id,
    accountId: tables.sessions.accountId,
    tokenDigest: tables.sessions.tokenDigest,
    claims: tables.sessions.claims,
    accountSecurityVersion: tables.sessions.accountSecurityVersion,
    authenticationMethod: tables.sessions.authenticationMethod,
    authenticationFactors: tables.sessions.authenticationFactors,
    authenticatedAt: tables.sessions.authenticatedAt,
    createdAt: tables.sessions.createdAt,
    lastSeenAt: tables.sessions.lastSeenAt,
    idleExpiresAt: tables.sessions.idleExpiresAt,
    absoluteExpiresAt: tables.sessions.absoluteExpiresAt,
    revokedAt: tables.sessions.revokedAt,
    revokeReason: tables.sessions.revokeReason,
    ipAddress: tables.sessions.ipAddress,
    userAgent: tables.sessions.userAgent,
  };
}

function mapSession<Claims>(
  session: ReturnType<typeof sessionSelection> extends infer _Selection
    ? {
        id: string;
        accountId: string;
        tokenDigest: Buffer;
        claims: unknown;
        accountSecurityVersion: number;
        authenticationMethod: string;
        authenticationFactors: string[];
        authenticatedAt: Date;
        createdAt: Date;
        lastSeenAt: Date;
        idleExpiresAt: Date;
        absoluteExpiresAt: Date;
        revokedAt: Date | null;
        revokeReason: string | null;
        ipAddress: string | null;
        userAgent: string | null;
      }
    : never,
): StoredSession<Claims> {
  return {
    id: session.id,
    accountId: session.accountId,
    tokenDigest: session.tokenDigest,
    claims: session.claims as Claims,
    accountSecurityVersion: session.accountSecurityVersion,
    evidence: {
      method: session.authenticationMethod,
      factors: session.authenticationFactors,
      authenticatedAt: session.authenticatedAt,
    },
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    ...(session.revokedAt === null ? {} : { revokedAt: session.revokedAt }),
    ...(session.revokeReason === null
      ? {}
      : { revokeReason: session.revokeReason }),
    ...(session.ipAddress === null ? {} : { ipAddress: session.ipAddress }),
    ...(session.userAgent === null ? {} : { userAgent: session.userAgent }),
  };
}
