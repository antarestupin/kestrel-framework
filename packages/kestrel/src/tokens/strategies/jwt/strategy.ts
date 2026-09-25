import type { TokenDefinition } from "../../definition.js";
import type {
  IssueTokenOptions,
  TokenGrant,
  TokenResolution,
  TokenStrategy,
} from "../../types.js";
import {
  JwtTokenCodec,
  type JwtTokenCodecOptions,
} from "./codec.js";

export type JwtTokenStrategyOptions = JwtTokenCodecOptions;

/** Stateless signed JWT strategy for reusable token definitions. */
export class JwtTokenStrategy implements TokenStrategy {
  public readonly capabilities = Object.freeze({
    pruning: false,
    revocation: false,
    singleUse: false,
    subjectDeletion: false,
  });

  private readonly codec: JwtTokenCodec;

  public constructor(options: JwtTokenStrategyOptions) {
    this.codec = new JwtTokenCodec(options);
  }

  public async issue<Payload>(
    definition: TokenDefinition<Payload>,
    payloads: readonly Payload[],
    options: IssueTokenOptions,
  ): Promise<readonly TokenGrant[]> {
    if (definition.usage === "single") {
      throw new TypeError(
        `JWT token "${definition.name}" cannot guarantee single-use consumption.`,
      );
    }
    if (definition.replacement !== "none") {
      throw new TypeError(
        `JWT token "${definition.name}" cannot replace previously issued stateless tokens.`,
      );
    }

    const issued = await this.codec.issue(definition, payloads, options);

    return issued.map(({ token, expiresAt }) => ({ token, expiresAt }));
  }

  public async verify<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<TokenResolution | undefined> {
    const verified = await this.codec.verify(definition, token);

    return verified === undefined
      ? undefined
      : { payload: verified.payload, expiresAt: verified.expiresAt };
  }
}
