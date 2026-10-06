import {
  decodeProtectedHeader,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from "jose";

import { uuidV7 } from "../../../utils/uuid.js";
import type { TokenDefinition } from "../../definition.js";
import { resolveTokenExpiration } from "../../lifetime.js";
import type {
  IssueTokenOptions,
  TokenGrant,
  TokenResolution,
} from "../../types.js";
import { JwtTokenKeyring } from "./keyring.js";

const TOKEN_DEFINITION_CLAIM = "token_definition";
const TOKEN_PAYLOAD_CLAIM = "token_payload";
const DEFAULT_TYPE = "token+jwt";
const DEFAULT_MAX_TOKEN_LENGTH = 16_384;

export interface JwtTokenCodecOptions {
  readonly issuer: string;
  readonly audience: string | readonly string[];
  readonly keyring: JwtTokenKeyring;
  readonly type?: string;
  readonly clockToleranceSeconds?: number;
  readonly maximumTokenLifetimeSeconds?: number;
  readonly maxTokenLength?: number;
  readonly now?: () => Date;
  /** Creates the integrity-protected JWT ID claim. */
  readonly createId?: () => string;
}

export interface IssuedJwtToken extends TokenGrant {
  readonly id: string;
  readonly issuedAt: Date;
  readonly subject?: string;
}

export interface VerifiedJwtToken extends TokenResolution {
  readonly id: string;
  readonly issuedAt: Date;
  readonly subject?: string;
  /** Exact clock value used for both JWT and optional state validation. */
  readonly verifiedAt: Date;
}

/** Shared JWT wire codec used by stateless and stateful strategies. */
export class JwtTokenCodec {
  private readonly audience: string | string[];

  private readonly clockToleranceSeconds: number;

  private readonly createId: () => string;

  private readonly maxTokenLength: number;

  private readonly maximumTokenLifetimeSeconds?: number;

  private readonly now: () => Date;

  private readonly issuer: string;

  private readonly keyring: JwtTokenKeyring;

  private readonly type: string;

  public constructor(options: JwtTokenCodecOptions) {
    validateNonEmpty(options.issuer, "JWT issuer");
    this.issuer = options.issuer;
    this.audience = normalizeAudience(options.audience);
    this.keyring = options.keyring;
    this.type = options.type ?? DEFAULT_TYPE;
    validateNonEmpty(this.type, "JWT type");
    this.clockToleranceSeconds = validateNonNegativeInteger(
      options.clockToleranceSeconds ?? 0,
      "JWT clockToleranceSeconds",
    );
    this.maxTokenLength = validatePositiveInteger(
      options.maxTokenLength ?? DEFAULT_MAX_TOKEN_LENGTH,
      "JWT maxTokenLength",
    );

    if (options.maximumTokenLifetimeSeconds !== undefined) {
      this.maximumTokenLifetimeSeconds = validatePositiveInteger(
        options.maximumTokenLifetimeSeconds,
        "JWT maximumTokenLifetimeSeconds",
      );
    }

    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? uuidV7;
  }

  /** Signs a complete batch against one consistent issuance instant. */
  public async issue<Payload>(
    definition: TokenDefinition<Payload>,
    payloads: readonly Payload[],
    options: IssueTokenOptions,
  ): Promise<readonly IssuedJwtToken[]> {
    const now = this.now();
    const requestedExpiration = resolveTokenExpiration(options, now);
    const issuedAt = toNumericDate(now);
    const expiration = toNumericDate(requestedExpiration);

    if (expiration <= issuedAt) {
      throw new TypeError(
        "JWT expiration must be at least one complete second after issuance.",
      );
    }
    this.validateLifetime(expiration - issuedAt);

    const normalizedIssuedAt = new Date(issuedAt * 1_000);
    const expiresAt = new Date(expiration * 1_000);
    const active = this.keyring.getActive();

    return Promise.all(payloads.map(async (payload) => {
      const subject = definition.subject?.(payload);
      validateOptionalSubject(subject);
      const id = this.createId();
      validateNonEmpty(id, "JWT ID");
      const jwt = new SignJWT({
        [TOKEN_DEFINITION_CLAIM]: definition.name,
        [TOKEN_PAYLOAD_CLAIM]: payload,
      })
        .setProtectedHeader({
          alg: active.algorithm,
          kid: active.id,
          typ: this.type,
        })
        .setIssuer(this.issuer)
        .setAudience(this.audience)
        .setIssuedAt(issuedAt)
        .setNotBefore(issuedAt)
        .setExpirationTime(expiration)
        .setJti(id);

      if (subject !== undefined) jwt.setSubject(subject);

      const token = await jwt.sign(active.key);

      if (token.length > this.maxTokenLength) {
        throw new TypeError(
          `JWT token "${definition.name}" exceeds ${this.maxTokenLength} characters.`,
        );
      }

      return {
        token,
        id,
        issuedAt: normalizedIssuedAt,
        expiresAt,
        ...(subject === undefined ? {} : { subject }),
      };
    }));
  }

  /** Verifies the complete JWT profile and returns integrity-bound metadata. */
  public async verify<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<VerifiedJwtToken | undefined> {
    if (token.length === 0 || token.length > this.maxTokenLength) {
      return undefined;
    }

    try {
      const header = decodeProtectedHeader(token);
      const key = this.keyring.resolve(header.kid, header.alg);

      if (key === undefined) return undefined;

      const now = this.now();
      const result = await jwtVerify(token, key.key, {
        algorithms: [key.algorithm],
        audience: this.audience,
        issuer: this.issuer,
        typ: this.type,
        clockTolerance: this.clockToleranceSeconds,
        currentDate: now,
        requiredClaims: [
          "iat",
          "nbf",
          "exp",
          "jti",
          TOKEN_DEFINITION_CLAIM,
          TOKEN_PAYLOAD_CLAIM,
        ],
      });

      if (!this.hasValidProfile(result.payload, definition, now)) {
        return undefined;
      }

      const parsed = await definition.payloadSchema.safeParseAsync(
        result.payload[TOKEN_PAYLOAD_CLAIM],
      );

      if (!parsed.success || !subjectMatches(definition, parsed.data, result.payload)) {
        return undefined;
      }

      return {
        id: result.payload.jti!,
        payload: parsed.data,
        issuedAt: new Date(result.payload.iat! * 1_000),
        expiresAt: new Date(result.payload.exp! * 1_000),
        verifiedAt: now,
        ...(result.payload.sub === undefined
          ? {}
          : { subject: result.payload.sub }),
      };
    } catch {
      // Every malformed, unverifiable, or expired bearer value fails closed.
      return undefined;
    }
  }

  private hasValidProfile<Payload>(
    payload: JWTPayload,
    definition: TokenDefinition<Payload>,
    now: Date,
  ): boolean {
    if (
      payload[TOKEN_DEFINITION_CLAIM] !== definition.name
      || typeof payload.jti !== "string"
      || payload.jti.trim().length === 0
      || !isNumericDate(payload.iat)
      || !isNumericDate(payload.nbf)
      || !isNumericDate(payload.exp)
      || payload.nbf !== payload.iat
      || payload.exp <= payload.nbf
      || payload.iat > toNumericDate(now) + this.clockToleranceSeconds
    ) {
      return false;
    }

    return this.isLifetimeValid(payload.exp - payload.iat);
  }

  private validateLifetime(lifetimeSeconds: number): void {
    if (!this.isLifetimeValid(lifetimeSeconds)) {
      throw new TypeError(
        `JWT lifetime exceeds ${this.maximumTokenLifetimeSeconds} seconds.`,
      );
    }
  }

  private isLifetimeValid(lifetimeSeconds: number): boolean {
    return this.maximumTokenLifetimeSeconds === undefined
      || lifetimeSeconds <= this.maximumTokenLifetimeSeconds;
  }
}

function subjectMatches<Payload>(
  definition: TokenDefinition<Payload>,
  payload: Payload,
  jwt: JWTPayload,
): boolean {
  const subject = definition.subject?.(payload);
  validateOptionalSubject(subject);

  return subject === undefined ? jwt.sub === undefined : jwt.sub === subject;
}

function isNumericDate(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function toNumericDate(value: Date): number {
  return Math.floor(value.getTime() / 1_000);
}

function normalizeAudience(
  audience: string | readonly string[],
): string | string[] {
  const values = typeof audience === "string" ? [audience] : [...audience];

  if (values.length === 0) {
    throw new TypeError("JWT audience must contain at least one value.");
  }
  for (const value of values) validateNonEmpty(value, "JWT audience");
  if (new Set(values).size !== values.length) {
    throw new TypeError("JWT audience values must be unique.");
  }

  return typeof audience === "string" ? audience : values;
}

function validateOptionalSubject(subject: string | undefined): void {
  if (subject !== undefined) validateNonEmpty(subject, "JWT subject");
}

function validateNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty.`);
  }
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }

  return value;
}

function validateNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }

  return value;
}
