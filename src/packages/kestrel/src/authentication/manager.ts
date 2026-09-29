import {
  createHash,
  randomBytes,
} from "node:crypto";
import type { ZodType } from "zod";

import { createUuid } from "../utils/uuid.js";
import type { AuthenticationConfig } from "./configuration.js";
import type { AuthenticationDefinition } from "./definition.js";
import {
  assertTrustedAuthenticationProof,
  type AuthenticationProof,
} from "./proof.js";
import type {
  AccountStore,
  SessionAccountResolver,
  SessionStore,
  StoredSession,
} from "./stores.js";
import type {
  AuthenticatedPrincipal,
  AuthenticationAccount,
  AuthenticationSubject,
  SubjectProvider,
} from "./types.js";

export interface AuthenticationAttemptMetadata {
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface SessionGrant<Claims> {
  readonly token: string;
  readonly principal: AuthenticatedPrincipal<Claims>;
}

export interface AuthenticationManagerDependencies<
  Subject extends AuthenticationSubject,
  Claims,
> {
  readonly accountStore: AccountStore;
  readonly sessionStore: SessionStore<Claims>;
  readonly subjectProvider: SubjectProvider<Subject>;
}

export interface AuthenticationManagerOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly createToken?: (bytes: number) => Uint8Array;
}

/** Completes trusted proofs and resolves revocable server-side sessions. */
export class AuthenticationManager<
  Claims,
  Subject extends AuthenticationSubject = AuthenticationSubject,
> {
  private readonly now: () => Date;

  private readonly createId: () => string;

  private readonly createToken: (bytes: number) => Uint8Array;

  public constructor(
    private readonly dependencies: AuthenticationManagerDependencies<Subject, Claims>,
    private readonly config: AuthenticationConfig,
    private readonly definition: AuthenticationDefinition<Subject, Claims>,
    options: AuthenticationManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? createUuid;
    this.createToken = options.createToken ?? randomBytes;
  }

  /** Creates a session only after a trusted mechanism supplied valid proof. */
  public async complete(
    proof: AuthenticationProof,
    metadata: AuthenticationAttemptMetadata = {},
  ): Promise<SessionGrant<Claims> | undefined> {
    assertTrustedAuthenticationProof(proof);
    const account = await this.dependencies.accountStore.findById(
      proof.accountId,
    );

    if (account === undefined || account.state !== "active") {
      return undefined;
    }

    const subject = await this.dependencies.subjectProvider.findById(
      account.subjectId,
    );

    if (subject === null) {
      return undefined;
    }

    const claims = await this.definition.sessionClaims.schema.parseAsync(
      await this.definition.sessionClaims.create({
        subject,
        account,
        evidence: proof.evidence,
      }),
    );
    this.assertClaimsSize(claims);

    const now = this.now();
    const token = Buffer.from(
      this.createToken(this.config.session.tokenBytes),
    ).toString("base64url");
    const session = await this.dependencies.sessionStore.createSession({
      id: this.createId(),
      accountId: account.id,
      tokenDigest: digestToken(token),
      claims,
      accountSecurityVersion: account.securityVersion,
      evidence: proof.evidence,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: addSeconds(now, this.config.session.idleTtlSeconds),
      absoluteExpiresAt: addSeconds(
        now,
        this.config.session.absoluteTtlSeconds,
      ),
      ...metadata,
    });

    return {
      token,
      principal: createPrincipal(account, session),
    };
  }

  /** Resolves and conditionally touches one opaque token, failing closed. */
  public async resolve(
    token: string,
  ): Promise<AuthenticatedPrincipal<Claims> | undefined> {
    if (!isCanonicalToken(token, this.config.session.tokenBytes)) {
      return undefined;
    }

    const tokenDigest = digestToken(token);
    const sessionAccountResolver = isSessionAccountResolver(
      this.dependencies.sessionStore,
    )
      ? this.dependencies.sessionStore
      : undefined;
    const combinedResolution = await sessionAccountResolver
      ?.findSessionAndAccountByTokenDigest(tokenDigest);
    const session = sessionAccountResolver === undefined
      ? await this.dependencies.sessionStore.findByTokenDigest(tokenDigest)
      : combinedResolution?.session;
    const now = this.now();

    if (!isSessionActive(session, now)) {
      return undefined;
    }

    const account = sessionAccountResolver === undefined
      ? await this.dependencies.accountStore.findById(session.accountId)
      : combinedResolution?.account;

    if (
      account === undefined
      || account.state !== "active"
      || account.securityVersion !== session.accountSecurityVersion
    ) {
      return undefined;
    }

    const claims = await this.parseClaims(session.claims);

    if (claims === undefined) {
      return undefined;
    }

    const activeSession = await this.touchIfNeeded(
      { ...session, claims },
      now,
    );

    return activeSession === undefined
      ? undefined
      : createPrincipal(account, activeSession);
  }

  public revokeSession(sessionId: string, reason = "logout"): Promise<boolean> {
    return this.dependencies.sessionStore.revoke({
      id: sessionId,
      revokedAt: this.now(),
      reason,
    });
  }

  public revokeAllForAccount(
    accountId: string,
    reason = "revoked-all",
  ): Promise<number> {
    return this.dependencies.sessionStore.revokeAllForAccount({
      accountId,
      revokedAt: this.now(),
      reason,
    });
  }

  private async parseClaims(value: unknown): Promise<Claims | undefined> {
    const result = await (this.definition.sessionClaims.schema as ZodType<Claims>)
      .safeParseAsync(value);

    if (!result.success) {
      return undefined;
    }

    try {
      this.assertClaimsSize(result.data);
      return result.data;
    } catch {
      return undefined;
    }
  }

  private assertClaimsSize(claims: Claims): void {
    const encoded = JSON.stringify(claims);

    if (
      encoded === undefined
      || Buffer.byteLength(encoded) > this.config.session.maxClaimsBytes
    ) {
      throw new TypeError("Authentication session claims are too large.");
    }
  }

  private async touchIfNeeded(
    session: StoredSession<Claims>,
    now: Date,
  ): Promise<StoredSession<Claims> | undefined> {
    const touchAfter = addSeconds(
      session.lastSeenAt,
      this.config.session.touchIntervalSeconds,
    );

    if (touchAfter > now) {
      return session;
    }

    const idleExpiresAt = new Date(Math.min(
      addSeconds(now, this.config.session.idleTtlSeconds).getTime(),
      session.absoluteExpiresAt.getTime(),
    ));

    return this.dependencies.sessionStore.touch({
      id: session.id,
      lastSeenAt: now,
      idleExpiresAt,
      now,
    });
  }
}

function isSessionAccountResolver<Claims>(
  store: SessionStore<Claims>,
): store is SessionStore<Claims> & SessionAccountResolver<Claims> {
  return "findSessionAndAccountByTokenDigest" in store
    && typeof store.findSessionAndAccountByTokenDigest === "function";
}

function createPrincipal<Claims>(
  account: AuthenticationAccount,
  session: StoredSession<Claims>,
): AuthenticatedPrincipal<Claims> {
  return {
    accountId: account.id,
    subjectId: account.subjectId,
    sessionId: session.id,
    claims: session.claims,
    authentication: {
      methods: [session.evidence.method],
      factors: [...session.evidence.factors],
      authenticatedAt: session.evidence.authenticatedAt,
    },
  };
}

function digestToken(token: string): Uint8Array {
  return createHash("sha256").update(token).digest();
}

function isCanonicalToken(token: string, tokenBytes: number): boolean {
  try {
    const decoded = Buffer.from(token, "base64url");

    return decoded.byteLength === tokenBytes
      && decoded.toString("base64url") === token;
  } catch {
    return false;
  }
}

function isSessionActive<Claims>(
  session: StoredSession<Claims> | undefined,
  now: Date,
): session is StoredSession<Claims> {
  return session !== undefined
    && session.revokedAt === undefined
    && session.idleExpiresAt > now
    && session.absoluteExpiresAt > now;
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1_000);
}
