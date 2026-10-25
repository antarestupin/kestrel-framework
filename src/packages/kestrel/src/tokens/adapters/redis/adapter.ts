import type { RedisClientType } from "@redis/client";
import { z } from "zod";
import type {
  CreateStoredToken, StoredToken, StoredTokenLookup, StoredTokenRevocation,
  StoredTokenSubjectMutation, TokenPruneOptions, TokenStorageAdapter,
} from "../../types.js";
import { redisTokensConfigBase, type RedisTokensConfig } from "./configuration.js";
import { tokenScript } from "./scripts.js";

const timestamp = z.union([z.number(), z.string().regex(/^-?\d+$/).transform(Number)]).pipe(z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000));
const storedSchema = z.object({
  version: z.literal(1), id: z.string().min(1), definition: z.string().min(1),
  subject: z.string().optional(), digest: z.string().min(1), payload: z.string(),
  expiresAt: timestamp, createdAt: timestamp, consumedAt: timestamp.optional(), revokedAt: timestamp.optional(),
});

/** Redis storage retains lifecycle records until explicit, bounded pruning. */
export class RedisTokenStorageAdapter implements TokenStorageAdapter {
  private readonly keys: string[];

  public constructor(
    private readonly client: Pick<RedisClientType, "eval">,
    settings: RedisTokensConfig = redisTokensConfigBase.schema.parse({}),
  ) {
    if (!settings.keyPrefix) throw new TypeError("Redis token key prefixes cannot be empty.");
    this.keys = ["records", "digests", "subjects", "expires", "inactive"].map((name) => `${settings.keyPrefix}{tokens}:${name}`);
  }

  public async createMany(tokens: readonly CreateStoredToken[]): Promise<void> {
    const ids = new Set<string>(), digests = new Set<string>(), replacements = new Set<string>();
    const stored = tokens.map((token) => {
      const record = storedSchema.parse({ ...token, version: 1, digest: digestKey(token.digest),
        // Lua must not reinterpret application JSON, especially empty arrays and large numbers.
        payload: JSON.stringify(z.json().parse(token.payload)),
        expiresAt: token.expiresAt.getTime(), createdAt: token.createdAt.getTime(),
        ...(token.consumedAt === undefined ? {} : { consumedAt: token.consumedAt.getTime() }),
        ...(token.revokedAt === undefined ? {} : { revokedAt: token.revokedAt.getTime() }),
      });
      if (ids.has(token.id) || digests.has(record.digest)) throw new TypeError("Stored token IDs and digests must be unique.");
      ids.add(token.id); digests.add(record.digest);
      const subjectIndex = token.subject === undefined ? undefined : JSON.stringify([token.definition, token.subject]);
      if (token.replaceExistingForSubject) {
        if (subjectIndex === undefined || replacements.has(subjectIndex)) throw new TypeError("Replacement tokens require a unique definition and subject per batch.");
        replacements.add(subjectIndex);
      }
      return { ...record, expiresAt: String(record.expiresAt), createdAt: String(record.createdAt),
        ...(record.consumedAt === undefined ? {} : { consumedAt: String(record.consumedAt) }),
        ...(record.revokedAt === undefined ? {} : { revokedAt: String(record.revokedAt) }),
        replaceExistingForSubject: token.replaceExistingForSubject,
        ...(subjectIndex === undefined ? {} : { subjectIndex }),
      };
    });
    if (stored.length) await this.count("create", stored);
  }

  public findValid(input: StoredTokenLookup): Promise<StoredToken | undefined> {
    return this.lookup("find", input);
  }

  public consume(input: StoredTokenLookup): Promise<StoredToken | undefined> {
    return this.lookup("consume", input);
  }

  public async revoke(input: StoredTokenRevocation): Promise<boolean> {
    const reply = await this.execute("revoke", { ...lookupInput(input), revokedAt: validTime(input.revokedAt) });
    if (reply === null) return false;
    if (reply !== 1) throw new TypeError("Invalid Redis token revocation result.");
    return true;
  }

  public async revokeForSubject(input: StoredTokenSubjectMutation): Promise<number> {
    return this.count("revokeSubject", subjectInput(input));
  }

  public async deleteForSubject(input: StoredTokenSubjectMutation): Promise<number> {
    return this.count("deleteSubject", subjectInput(input));
  }

  public async prune(options: TokenPruneOptions): Promise<number> {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) throw new TypeError("Token prune limits must be positive safe integers.");
    return this.count("prune", { expiredBefore: validTime(options.expiredBefore), inactiveBefore: validTime(options.inactiveBefore), limit: options.limit });
  }

  private async lookup(mode: string, input: StoredTokenLookup): Promise<StoredToken | undefined> {
    const reply = await this.execute(mode, lookupInput(input));
    if (reply === null) return undefined;
    if (typeof reply !== "string") throw new TypeError("Invalid Redis token lookup result.");
    const stored = storedSchema.parse(JSON.parse(reply));
    if (stored.definition !== input.definition || stored.digest !== digestKey(input.digest)) throw new TypeError("Redis returned a different token identity.");
    return {
      id: stored.id, definition: stored.definition, digest: new Uint8Array(Buffer.from(stored.digest, "base64url")), payload: z.json().parse(JSON.parse(stored.payload)),
      ...(stored.subject === undefined ? {} : { subject: stored.subject }),
      expiresAt: new Date(stored.expiresAt), createdAt: new Date(stored.createdAt),
      ...(stored.consumedAt === undefined ? {} : { consumedAt: new Date(stored.consumedAt) }),
      ...(stored.revokedAt === undefined ? {} : { revokedAt: new Date(stored.revokedAt) }),
    };
  }

  private async count(mode: string, input: unknown): Promise<number> {
    return z.number().int().nonnegative().parse(await this.execute(mode, input));
  }

  private execute(mode: string, input: unknown): Promise<unknown> {
    return this.client.eval(tokenScript, { keys: this.keys, arguments: [mode, JSON.stringify(input)] });
  }
}

function digestKey(digest: Uint8Array): string {
  if (!digest.byteLength) throw new TypeError("Token digests cannot be empty.");
  return Buffer.from(digest).toString("base64url");
}
function validTime(date: Date): number { return timestamp.parse(date.getTime()); }
function lookupInput(input: StoredTokenLookup) {
  return { definition: input.definition, digest: digestKey(input.digest), now: validTime(input.now) };
}
function subjectInput(input: StoredTokenSubjectMutation) {
  return { subjectIndex: JSON.stringify([input.definition, input.subject]), now: validTime(input.now) };
}
