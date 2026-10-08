import {
  createHash,
} from "node:crypto";

import { uuidV7 } from "../../../utils/uuid.js";
import type { TokenDefinition } from "../../definition.js";
import type {
  CreateStoredToken,
  IssueTokenOptions,
  StoredToken,
  TokenGrant,
  TokenPruneOptions,
  TokenResolution,
  TokenStorageAdapter,
  TokenStrategy,
} from "../../types.js";
import {
  JwtTokenCodec,
  type JwtTokenCodecOptions,
  type VerifiedJwtToken,
} from "../jwt/codec.js";

const HYBRID_STATE_MARKER = "hybrid-jwt";

export interface HybridTokenStrategyOptions extends JwtTokenCodecOptions {
  /** Creates the non-secret identity of the persisted lifecycle row. */
  readonly createStateId?: () => string;
  /** Digests the signed JWT ID before persistence and lookup. */
  readonly digestId?: (id: string) => Uint8Array;
}

/** Signed JWT strategy backed by minimal server-side lifecycle state. */
export class HybridTokenStrategy implements TokenStrategy {
  public readonly capabilities = Object.freeze({
    pruning: true,
    revocation: true,
    singleUse: true,
    subjectDeletion: true,
  });

  public readonly pruningScope: object;

  private readonly codec: JwtTokenCodec;

  private readonly createStateId: () => string;

  private readonly digestId: (id: string) => Uint8Array;

  private readonly now: () => Date;

  public constructor(
    private readonly store: TokenStorageAdapter,
    options: HybridTokenStrategyOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.codec = new JwtTokenCodec({ ...options, now: this.now });
    this.createStateId = options.createStateId ?? uuidV7;
    this.digestId = options.digestId
      ?? ((id) => createHash("sha256").update(id).digest());
    this.pruningScope = store;
  }

  public async issue<Payload>(
    definition: TokenDefinition<Payload>,
    payloads: readonly Payload[],
    options: IssueTokenOptions,
  ): Promise<readonly TokenGrant[]> {
    const issued = await this.codec.issue(definition, payloads, options);
    const states: CreateStoredToken[] = issued.map((token) => ({
      id: this.createStateId(),
      definition: definition.name,
      ...(token.subject === undefined ? {} : { subject: token.subject }),
      digest: this.digestId(token.id),
      // Only a representation marker is stored; application data stays in the JWT.
      payload: { tokenRepresentation: HYBRID_STATE_MARKER },
      expiresAt: token.expiresAt,
      createdAt: token.issuedAt,
      replaceExistingForSubject:
        definition.replacement === "same-subject",
    }));

    // State creation is one atomic batch; no grant escapes when persistence fails.
    await this.store.createMany(states);

    return issued.map(({ token, expiresAt }) => ({ token, expiresAt }));
  }

  public async verify<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<TokenResolution | undefined> {
    const verified = await this.codec.verify(definition, token);

    if (verified === undefined) return undefined;

    const state = await this.store.findValid({
      definition: definition.name,
      digest: this.digestId(verified.id),
      now: verified.verifiedAt,
    });

    return this.resolveState(state, verified);
  }

  public async consume<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<TokenResolution | undefined> {
    const verified = await this.codec.verify(definition, token);

    if (verified === undefined) return undefined;

    const state = await this.store.consume({
      definition: definition.name,
      digest: this.digestId(verified.id),
      now: verified.verifiedAt,
    });

    return this.resolveState(state, verified);
  }

  public async revoke<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<boolean> {
    const verified = await this.codec.verify(definition, token);

    if (verified === undefined) return false;

    return this.store.revoke({
      definition: definition.name,
      digest: this.digestId(verified.id),
      now: verified.verifiedAt,
      revokedAt: verified.verifiedAt,
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

  private resolveState(
    state: StoredToken | undefined,
    verified: VerifiedJwtToken,
  ): TokenResolution | undefined {
    if (
      state === undefined
      || !isHybridState(state.payload)
      || state.expiresAt.getTime() !== verified.expiresAt.getTime()
      || state.createdAt.getTime() !== verified.issuedAt.getTime()
      || state.subject !== verified.subject
    ) {
      return undefined;
    }

    return {
      payload: verified.payload,
      expiresAt: verified.expiresAt,
    };
  }
}

function isHybridState(payload: unknown): boolean {
  return typeof payload === "object"
    && payload !== null
    && Object.keys(payload).length === 1
    && "tokenRepresentation" in payload
    && payload.tokenRepresentation === HYBRID_STATE_MARKER;
}
