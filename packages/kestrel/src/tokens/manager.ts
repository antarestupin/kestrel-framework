import type { TokenDefinition } from "./definition.js";
import type {
  IssueTokenOptions,
  TokenGrant,
  TokenPruneOptions,
  TokenStrategy,
} from "./types.js";

export interface TokenManagerOptions {
  readonly defaultStrategy?: string;
  readonly maxPayloadBytes: number;
}

/** Typed application facade routing token definitions to their strategies. */
export class TokenManager {
  private readonly defaultStrategy: string;

  public constructor(
    private readonly strategies: Readonly<Record<string, TokenStrategy>>,
    private readonly options: TokenManagerOptions,
  ) {
    this.defaultStrategy = options.defaultStrategy ?? "stored";

    if (
      !Number.isInteger(options.maxPayloadBytes)
      || options.maxPayloadBytes <= 0
    ) {
      throw new TypeError("Token maxPayloadBytes must be a positive integer.");
    }
  }

  public async issue<Payload>(
    definition: TokenDefinition<Payload>,
    rawPayload: Payload,
    options: IssueTokenOptions,
  ): Promise<TokenGrant> {
    const grants = await this.issueMany(definition, [rawPayload], options);
    const grant = grants[0];

    if (grant === undefined) {
      throw new Error("The token strategy did not return the issued token.");
    }

    return grant;
  }

  /** Validates the complete batch before issuing it in one strategy call. */
  public async issueMany<Payload>(
    definition: TokenDefinition<Payload>,
    rawPayloads: readonly Payload[],
    options: IssueTokenOptions,
  ): Promise<readonly TokenGrant[]> {
    const strategy = this.resolveStrategy(definition);
    this.requireSingleUseSupport(definition, strategy);
    const payloads = await Promise.all(rawPayloads.map(
      (payload) => this.normalizePayload(definition, payload),
    ));
    this.validateSubjects(definition, payloads);

    return strategy.issue(definition, payloads, options);
  }

  /** Verifies reusable tokens without changing their lifecycle. */
  public async verify<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<Payload | undefined> {
    if (definition.usage === "single") {
      throw new TypeError(
        `Single-use token "${definition.name}" must be consumed, not verified.`,
      );
    }

    const resolution = await this.resolveStrategy(definition)
      .verify(definition, token);

    return resolution === undefined
      ? undefined
      : this.parseResolvedPayload(definition, resolution.payload);
  }

  /** Atomically validates and consumes one single-use token. */
  public async consume<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<Payload | undefined> {
    if (definition.usage !== "single") {
      throw new TypeError(
        `Reusable token "${definition.name}" must be verified, not consumed.`,
      );
    }

    const strategy = this.resolveStrategy(definition);
    this.requireSingleUseSupport(definition, strategy);
    const resolution = await strategy.consume!(definition, token);

    return resolution === undefined
      ? undefined
      : this.parseResolvedPayload(definition, resolution.payload);
  }

  public revoke<Payload>(
    definition: TokenDefinition<Payload>,
    token: string,
  ): Promise<boolean> {
    const strategy = this.resolveStrategy(definition);
    this.requireRevocation(definition, strategy);

    return strategy.revoke!(definition, token);
  }

  public revokeForSubject<Payload>(
    definition: TokenDefinition<Payload>,
    subject: string,
  ): Promise<number> {
    const strategy = this.resolveStrategy(definition);
    this.requireRevocation(definition, strategy);
    this.requireSubjectDefinition(definition);

    return strategy.revokeForSubject!(definition, validateSubject(subject));
  }

  public deleteForSubject<Payload>(
    definition: TokenDefinition<Payload>,
    subject: string,
  ): Promise<number> {
    const strategy = this.resolveStrategy(definition);
    this.requireSubjectDefinition(definition);

    if (
      !strategy.capabilities.subjectDeletion
      || strategy.deleteForSubject === undefined
    ) {
      throw new TypeError(
        `Token strategy "${definition.strategy}" does not support subject deletion for "${definition.name}".`,
      );
    }

    return strategy.deleteForSubject(
      definition,
      validateSubject(subject),
    );
  }

  /** Prunes each distinct state store once, even when strategies share it. */
  public async prune(options: TokenPruneOptions): Promise<number> {
    validatePruneOptions(options);
    const strategies = new Set(Object.values(this.strategies));
    const prunedScopes = new Set<object>();
    let removed = 0;

    for (const strategy of strategies) {
      if (strategy.capabilities.pruning && strategy.prune !== undefined) {
        const scope = strategy.pruningScope ?? strategy;

        if (prunedScopes.has(scope)) continue;
        prunedScopes.add(scope);
        removed += await strategy.prune(options);
      }
    }

    return removed;
  }

  private resolveStrategy<Payload>(
    definition: TokenDefinition<Payload>,
  ): TokenStrategy {
    const name = definition.strategy || this.defaultStrategy;
    const strategy = this.strategies[name];

    if (strategy === undefined) {
      throw new TypeError(
        `Token strategy "${name}" required by "${definition.name}" is not registered.`,
      );
    }

    return strategy;
  }

  private async normalizePayload<Payload>(
    definition: TokenDefinition<Payload>,
    rawPayload: Payload,
  ): Promise<Payload> {
    const payload = await definition.payloadSchema.parseAsync(rawPayload);
    let encoded: string | undefined;

    try {
      encoded = JSON.stringify(payload);
    } catch {
      throw new TypeError(
        `Token "${definition.name}" payload must be JSON-compatible.`,
      );
    }

    if (encoded === undefined) {
      throw new TypeError(
        `Token "${definition.name}" payload must be JSON-compatible.`,
      );
    }
    if (
      new TextEncoder().encode(encoded).byteLength
        > this.options.maxPayloadBytes
    ) {
      throw new TypeError(
        `Token "${definition.name}" payload exceeds ${this.options.maxPayloadBytes} bytes.`,
      );
    }

    // Revalidation rejects schemas whose runtime representation changes in JSON.
    return definition.payloadSchema.parseAsync(JSON.parse(encoded));
  }

  private async parseResolvedPayload<Payload>(
    definition: TokenDefinition<Payload>,
    payload: unknown,
  ): Promise<Payload | undefined> {
    try {
      return await this.normalizePayload(definition, payload as Payload);
    } catch {
      // Persisted values are untrusted and fail closed without leaking details.
      return undefined;
    }
  }

  private validateSubjects<Payload>(
    definition: TokenDefinition<Payload>,
    payloads: readonly Payload[],
  ): void {
    if (definition.subject === undefined) return;

    const subjects = new Set<string>();

    for (const payload of payloads) {
      const resolved = definition.subject(payload);

      if (resolved === undefined && definition.replacement === "none") {
        continue;
      }

      const subject = validateSubject(resolved);

      if (
        definition.replacement === "same-subject"
        && subjects.has(subject)
      ) {
        throw new TypeError(
          `Token batch "${definition.name}" contains the same replacement subject more than once.`,
        );
      }
      if (definition.replacement === "same-subject") {
        subjects.add(subject);
      }
    }
  }

  private requireSingleUseSupport<Payload>(
    definition: TokenDefinition<Payload>,
    strategy: TokenStrategy,
  ): void {
    if (
      definition.usage === "single"
      && (
        !strategy.capabilities.singleUse
        || strategy.consume === undefined
      )
    ) {
      throw new TypeError(
        `Token strategy "${definition.strategy}" does not support single-use token "${definition.name}".`,
      );
    }
  }

  private requireRevocation<Payload>(
    definition: TokenDefinition<Payload>,
    strategy: TokenStrategy,
  ): void {
    if (
      !strategy.capabilities.revocation
      || strategy.revoke === undefined
      || strategy.revokeForSubject === undefined
    ) {
      throw new TypeError(
        `Token strategy "${definition.strategy}" does not support revocation for "${definition.name}".`,
      );
    }
  }

  private requireSubjectDefinition<Payload>(
    definition: TokenDefinition<Payload>,
  ): void {
    if (definition.subject === undefined) {
      throw new TypeError(
        `Token "${definition.name}" does not declare a subject.`,
      );
    }
  }
}

function validateSubject(subject: string | undefined): string {
  if (subject === undefined || subject.trim().length === 0) {
    throw new TypeError("Token subjects must not be empty.");
  }

  return subject;
}

function validatePruneOptions(options: TokenPruneOptions): void {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new TypeError("Token prune limit must be a positive integer.");
  }
  if (
    Number.isNaN(options.expiredBefore.getTime())
    || Number.isNaN(options.inactiveBefore.getTime())
  ) {
    throw new TypeError("Token prune dates must be valid dates.");
  }
}
