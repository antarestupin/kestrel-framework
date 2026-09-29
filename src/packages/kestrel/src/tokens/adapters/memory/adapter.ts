import type {
  CreateStoredToken,
  StoredToken,
  StoredTokenLookup,
  StoredTokenRevocation,
  StoredTokenSubjectMutation,
  TokenPruneOptions,
  TokenStore,
} from "../../types.js";

/** Process-local token storage with the same lifecycle semantics as PostgreSQL. */
export class MemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, StoredToken>();

  public async createMany(tokens: readonly CreateStoredToken[]): Promise<void> {
    const digests = new Set<string>();
    const ids = new Set<string>();
    const replacements = new Set<string>();

    // Validate the complete batch before changing existing token state.
    for (const token of tokens) {
      const digest = digestKey(token.digest);

      if (
        ids.has(token.id)
        || this.tokens.has(token.id)
        || digests.has(digest)
        || this.findByDigest(digest) !== undefined
      ) {
        throw new Error("Stored token IDs and digests must be unique.");
      }
      if (token.replaceExistingForSubject && token.subject === undefined) {
        throw new TypeError("Replacement tokens require a subject.");
      }
      if (token.replaceExistingForSubject) {
        const replacement = `${token.definition}\0${token.subject}`;

        if (replacements.has(replacement)) {
          throw new TypeError(
            "A token batch cannot replace the same definition and subject more than once.",
          );
        }
        replacements.add(replacement);
      }

      ids.add(token.id);
      digests.add(digest);
    }

    for (const token of tokens) {
      if (token.replaceExistingForSubject) {
        for (const [id, existing] of this.tokens) {
          if (
            existing.definition === token.definition
            && existing.subject === token.subject
            && existing.consumedAt === undefined
            && existing.revokedAt === undefined
          ) {
            this.tokens.set(id, cloneToken({
              ...existing,
              revokedAt: token.createdAt,
            }));
          }
        }
      }

      this.tokens.set(token.id, cloneToken(token));
    }
  }

  public async findValid(
    input: StoredTokenLookup,
  ): Promise<StoredToken | undefined> {
    const token = this.findByDigest(digestKey(input.digest));

    return isValid(token, input)
      ? cloneToken(token)
      : undefined;
  }

  public async consume(
    input: StoredTokenLookup,
  ): Promise<StoredToken | undefined> {
    const token = this.findByDigest(digestKey(input.digest));

    if (!isValid(token, input)) return undefined;

    const consumed = cloneToken({ ...token, consumedAt: input.now });
    this.tokens.set(token.id, consumed);

    return cloneToken(consumed);
  }

  public async revoke(input: StoredTokenRevocation): Promise<boolean> {
    const token = this.findByDigest(digestKey(input.digest));

    if (!isValid(token, input)) return false;

    this.tokens.set(token.id, cloneToken({
      ...token,
      revokedAt: input.revokedAt,
    }));

    return true;
  }

  public async revokeForSubject(
    input: StoredTokenSubjectMutation,
  ): Promise<number> {
    let revoked = 0;

    for (const [id, token] of this.tokens) {
      if (
        token.definition === input.definition
        && token.subject === input.subject
        && token.expiresAt.getTime() > input.now.getTime()
        && token.consumedAt === undefined
        && token.revokedAt === undefined
      ) {
        this.tokens.set(id, cloneToken({ ...token, revokedAt: input.now }));
        revoked += 1;
      }
    }

    return revoked;
  }

  public async deleteForSubject(
    input: StoredTokenSubjectMutation,
  ): Promise<number> {
    let removed = 0;

    for (const [id, token] of this.tokens) {
      if (
        token.definition === input.definition
        && token.subject === input.subject
      ) {
        this.tokens.delete(id);
        removed += 1;
      }
    }

    return removed;
  }

  public async prune(options: TokenPruneOptions): Promise<number> {
    const candidates = [...this.tokens.values()]
      .filter((token) => isPrunable(token, options))
      .sort((left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime()
        || left.id.localeCompare(right.id))
      .slice(0, options.limit);

    for (const token of candidates) {
      this.tokens.delete(token.id);
    }

    return candidates.length;
  }

  private findByDigest(digest: string): StoredToken | undefined {
    for (const token of this.tokens.values()) {
      if (digestKey(token.digest) === digest) return token;
    }

    return undefined;
  }
}

function isValid(
  token: StoredToken | undefined,
  input: StoredTokenLookup,
): token is StoredToken {
  return token !== undefined
    && token.definition === input.definition
    && token.expiresAt.getTime() > input.now.getTime()
    && token.consumedAt === undefined
    && token.revokedAt === undefined;
}

function isPrunable(token: StoredToken, options: TokenPruneOptions): boolean {
  return token.expiresAt.getTime() <= options.expiredBefore.getTime()
    || (
      token.consumedAt !== undefined
      && token.consumedAt.getTime() <= options.inactiveBefore.getTime()
    )
    || (
      token.revokedAt !== undefined
      && token.revokedAt.getTime() <= options.inactiveBefore.getTime()
    );
}

function cloneToken(token: StoredToken): StoredToken {
  return {
    ...token,
    digest: new Uint8Array(token.digest),
    payload: structuredClone(token.payload),
    expiresAt: new Date(token.expiresAt),
    ...(token.consumedAt === undefined
      ? {}
      : { consumedAt: new Date(token.consumedAt) }),
    ...(token.revokedAt === undefined
      ? {}
      : { revokedAt: new Date(token.revokedAt) }),
    createdAt: new Date(token.createdAt),
  };
}

function digestKey(digest: Uint8Array): string {
  return Buffer.from(digest).toString("base64url");
}
