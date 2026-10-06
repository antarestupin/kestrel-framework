import {
  createHash,
  randomBytes,
} from "node:crypto";

import { uuidV7 } from "../utils/uuid.js";
import type { TokenDefinition } from "./definition.js";
import { resolveTokenExpiration } from "./lifetime.js";
import type {
  CreateStoredToken,
  IssueTokenOptions,
  TokenGrant,
  TokenPruneOptions,
  TokenResolution,
  TokenStore,
  TokenStrategy,
} from "./types.js";

export interface StoredTokenStrategyOptions {
  readonly tokenBytes: number;
  readonly now?: () => Date;
  readonly randomToken?: (bytes: number) => string;
  readonly createId?: () => string;
  readonly digest?: (token: string) => Uint8Array;
}

/** Opaque bearer-token strategy that persists only fixed-length digests. */
export class StoredTokenStrategy implements TokenStrategy {
  public readonly capabilities = Object.freeze({
    pruning: true,
    revocation: true,
    singleUse: true,
    subjectDeletion: true,
  });

  public readonly pruningScope: object;

  private readonly now: () => Date;

  private readonly randomToken: (bytes: number) => string;

  private readonly createId: () => string;

  private readonly digest: (token: string) => Uint8Array;

  public constructor(
    private readonly store: TokenStore,
    private readonly options: StoredTokenStrategyOptions,
  ) {
    if (!Number.isInteger(options.tokenBytes) || options.tokenBytes < 32) {
      throw new TypeError("Stored tokenBytes must be an integer of at least 32.");
    }

    this.now = options.now ?? (() => new Date());
    this.randomToken = options.randomToken
      ?? ((bytes) => randomBytes(bytes).toString("base64url"));
    this.createId = options.createId ?? uuidV7;
    this.digest = options.digest
      ?? ((token) => createHash("sha256").update(token).digest());
    this.pruningScope = store;
  }

  public async issue<Payload>(
    definition: TokenDefinition<Payload>,
    payloads: readonly Payload[],
    options: IssueTokenOptions,
  ): Promise<readonly TokenGrant[]> {
    const now = this.now();
    const expiresAt = resolveTokenExpiration(options, now);
    const grants: TokenGrant[] = [];
    const stored: CreateStoredToken[] = [];

    for (const payload of payloads) {
      const token = this.randomToken(this.options.tokenBytes);
      const subject = definition.subject?.(payload);

      grants.push({ token, expiresAt });
      stored.push({
        id: this.createId(),
        definition: definition.name,
        ...(subject === undefined ? {} : { subject }),
        digest: this.digest(token),
        payload,
        expiresAt,
        createdAt: now,
        replaceExistingForSubject:
          definition.replacement === "same-subject",
      });
    }

    await this.store.createMany(stored);

    return grants;
  }

  public async verify<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<TokenResolution | undefined> {
    const digest = this.parseDigest(token);
    if (digest === undefined) return undefined;

    const stored = await this.store.findValid({
      definition: definition.name,
      digest,
      now: this.now(),
    });

    return stored === undefined
      ? undefined
      : { payload: stored.payload, expiresAt: stored.expiresAt };
  }

  public async consume<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<TokenResolution | undefined> {
    const digest = this.parseDigest(token);
    if (digest === undefined) return undefined;

    const stored = await this.store.consume({
      definition: definition.name,
      digest,
      now: this.now(),
    });

    return stored === undefined
      ? undefined
      : { payload: stored.payload, expiresAt: stored.expiresAt };
  }

  public revoke<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<boolean> {
    const digest = this.parseDigest(token);
    if (digest === undefined) return Promise.resolve(false);
    const now = this.now();

    return this.store.revoke({
      definition: definition.name,
      digest,
      now,
      revokedAt: now,
    });
  }

  public revokeForSubject<Payload>(
    definition: TokenDefinition<Payload>,
    subject: string,
  ): Promise<number> {
    return this.store.revokeForSubject({
      definition: definition.name,
      subject,
      now: this.now(),
    });
  }

  public deleteForSubject<Payload>(
    definition: TokenDefinition<Payload>,
    subject: string,
  ): Promise<number> {
    return this.store.deleteForSubject({
      definition: definition.name,
      subject,
      now: this.now(),
    });
  }

  public prune(options: TokenPruneOptions): Promise<number> {
    return this.store.prune(options);
  }

  private parseDigest(token: string): Uint8Array | undefined {
    if (token.length === 0) return undefined;

    const bytes = Buffer.from(token, "base64url");

    if (
      bytes.byteLength !== this.options.tokenBytes
      || bytes.toString("base64url") !== token
    ) {
      return undefined;
    }

    return this.digest(token);
  }
}
