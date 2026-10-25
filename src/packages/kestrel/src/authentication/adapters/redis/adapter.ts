import type { RedisClientType } from "@redis/client";
import { z } from "zod";
import type {
  CreateStoredSession, RevokeAccountSessions, RevokeStoredSession,
  SessionStorageAdapter, StoredSession, TouchStoredSession,
} from "../../stores.js";
import { redisSessionsConfigBase, type RedisSessionsConfig } from "./configuration.js";
import { sessionScript } from "./scripts.js";

const timestamp = z.union([z.number(), z.string().regex(/^-?\d+$/).transform(Number)]).pipe(z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000));
const evidenceSchema = z.object({ method: z.string(), factors: z.array(z.string()), authenticatedAt: timestamp });
const storedSchema = z.object({
  version: z.literal(1), id: z.string().min(1), accountId: z.string().min(1), digest: z.string().min(1),
  claims: z.string(), evidence: z.string(), accountSecurityVersion: z.number().int().nonnegative(),
  createdAt: timestamp, lastSeenAt: timestamp, idleExpiresAt: timestamp, absoluteExpiresAt: timestamp,
  revokedAt: timestamp.optional(), revokeReason: z.string().optional(), ipAddress: z.string().optional(), userAgent: z.string().optional(),
});

/** Sessions use Redis directly; account state and credentials remain independently supplied. */
export class RedisSessionStorageAdapter<Claims = unknown> implements SessionStorageAdapter<Claims> {
  private readonly keys: string[];

  public constructor(
    private readonly client: Pick<RedisClientType, "eval">,
    settings: RedisSessionsConfig = redisSessionsConfigBase.schema.parse({}),
  ) {
    if (!settings.keyPrefix) throw new TypeError("Redis session key prefixes cannot be empty.");
    this.keys = ["records", "digests", "accounts"].map((name) => `${settings.keyPrefix}{sessions}:${name}`);
  }

  public async createSession(input: CreateStoredSession<Claims>): Promise<StoredSession<Claims>> {
    const record = storedSchema.parse({
      ...input, version: 1, digest: digestKey(input.tokenDigest),
      // Keep application JSON opaque to Lua, preserving empty arrays and numeric precision.
      claims: JSON.stringify(z.json().parse(input.claims)),
      evidence: JSON.stringify(evidenceSchema.parse({ ...input.evidence, authenticatedAt: validTime(input.evidence.authenticatedAt) })),
      createdAt: validTime(input.createdAt), lastSeenAt: validTime(input.lastSeenAt),
      idleExpiresAt: validTime(input.idleExpiresAt), absoluteExpiresAt: validTime(input.absoluteExpiresAt),
      ...(input.revokedAt === undefined ? {} : { revokedAt: validTime(input.revokedAt) }),
    });
    if (record.idleExpiresAt > record.absoluteExpiresAt) throw new TypeError("Idle expiration cannot exceed absolute expiration.");
    return this.decode(await this.execute("create", { ...record,
      createdAt: String(record.createdAt), lastSeenAt: String(record.lastSeenAt),
      idleExpiresAt: String(record.idleExpiresAt), absoluteExpiresAt: String(record.absoluteExpiresAt),
      ...(record.revokedAt === undefined ? {} : { revokedAt: String(record.revokedAt) }),
    }));
  }

  public async findByTokenDigest(tokenDigest: Uint8Array): Promise<StoredSession<Claims> | undefined> {
    const reply = await this.execute("find", { digest: digestKey(tokenDigest) });
    if (reply === null) return undefined;
    const session = this.decode(reply);
    if (digestKey(session.tokenDigest) !== digestKey(tokenDigest)) throw new TypeError("Redis returned a different session digest.");
    return session;
  }

  public async touch(input: TouchStoredSession): Promise<StoredSession<Claims> | undefined> {
    const reply = await this.execute("touch", {
      id: input.id, lastSeenAt: validTime(input.lastSeenAt), idleExpiresAt: validTime(input.idleExpiresAt), now: validTime(input.now),
    });
    return reply === null ? undefined : this.decode(reply);
  }

  public async revoke(input: RevokeStoredSession): Promise<boolean> {
    const reply = await this.execute("revoke", { ...input, revokedAt: validTime(input.revokedAt) });
    if (reply === null) return false;
    if (reply !== 1) throw new TypeError("Invalid Redis session revocation result.");
    return true;
  }

  public async revokeAllForAccount(input: RevokeAccountSessions): Promise<number> {
    return z.number().int().nonnegative().parse(await this.execute("revokeAccount", { ...input, revokedAt: validTime(input.revokedAt) }));
  }

  public async listForAccount(accountId: string): Promise<readonly StoredSession<Claims>[]> {
    const reply = await this.execute("list", { accountId });
    if (typeof reply !== "string") throw new TypeError("Invalid Redis session list result.");
    return z.array(z.unknown()).parse(JSON.parse(reply)).map((record) => this.decode(JSON.stringify(record)));
  }

  private decode(reply: unknown): StoredSession<Claims> {
    if (typeof reply !== "string") throw new TypeError("Invalid Redis session result.");
    const record = storedSchema.parse(JSON.parse(reply));
    const evidence = evidenceSchema.parse(JSON.parse(record.evidence));
    return {
      id: record.id, accountId: record.accountId, tokenDigest: new Uint8Array(Buffer.from(record.digest, "base64url")),
      claims: z.json().parse(JSON.parse(record.claims)) as Claims,
      accountSecurityVersion: record.accountSecurityVersion,
      evidence: { ...evidence, authenticatedAt: new Date(evidence.authenticatedAt) },
      createdAt: new Date(record.createdAt), lastSeenAt: new Date(record.lastSeenAt),
      idleExpiresAt: new Date(record.idleExpiresAt), absoluteExpiresAt: new Date(record.absoluteExpiresAt),
      ...(record.revokedAt === undefined ? {} : { revokedAt: new Date(record.revokedAt) }),
      ...(record.revokeReason === undefined ? {} : { revokeReason: record.revokeReason }),
      ...(record.ipAddress === undefined ? {} : { ipAddress: record.ipAddress }),
      ...(record.userAgent === undefined ? {} : { userAgent: record.userAgent }),
    };
  }

  private execute(mode: string, input: unknown): Promise<unknown> {
    return this.client.eval(sessionScript, { keys: this.keys, arguments: [mode, JSON.stringify(input)] });
  }
}

function validTime(date: Date): number { return timestamp.parse(date.getTime()); }
function digestKey(digest: Uint8Array): string {
  if (!digest.byteLength) throw new TypeError("Session digests cannot be empty.");
  return Buffer.from(digest).toString("base64url");
}
