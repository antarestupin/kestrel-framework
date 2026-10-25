import type { RedisClientType } from "@redis/client";
import { z } from "zod";
import type { LockAcquireRequest, LockAdapter, LockLease, LockReleaseRequest } from "../../types.js";
import { redisLocksConfigBase, type RedisLocksConfig } from "./configuration.js";
import { mutateLocks, releaseLock } from "./scripts.js";

const leaseSchema = z.object({
  version: z.literal(1), key: z.string(), ownerId: z.string(),
  expiresAt: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().max(8_640_000_000_000_000)), fencingToken: z.string().regex(/^\d+$/),
});

/** Native expiring leases with a persistent fencing sequence, on one Redis primary. */
export class RedisLockAdapter implements LockAdapter {
  private readonly prefix: string;

  public constructor(
    private readonly client: Pick<RedisClientType, "eval">,
    settings: RedisLocksConfig = redisLocksConfigBase.schema.parse({}),
  ) {
    if (!settings.keyPrefix) throw new TypeError("Redis lock key prefixes cannot be empty.");
    // All batch keys share one cluster slot; user keys cannot inject hash tags.
    this.prefix = `${settings.keyPrefix}{locks}:`;
  }

  public async tryAcquire(request: LockAcquireRequest): Promise<LockLease | undefined> {
    return (await this.tryAcquireMany([request]))?.[0];
  }

  public tryAcquireMany(requests: readonly LockAcquireRequest[]): Promise<readonly LockLease[] | undefined> {
    return this.mutate("acquire", requests);
  }

  public async extend(request: LockAcquireRequest): Promise<LockLease | undefined> {
    return (await this.extendMany([request]))?.[0];
  }

  public extendMany(requests: readonly LockAcquireRequest[]): Promise<readonly LockLease[] | undefined> {
    return this.mutate("extend", requests);
  }

  public async release(request: LockReleaseRequest): Promise<boolean> {
    const result = await this.client.eval(releaseLock, {
      keys: [this.leaseKey(request.key)], arguments: [request.ownerId],
    });
    if (result !== 0 && result !== 1) throw new TypeError("Invalid Redis lock release result.");
    return result === 1;
  }

  private leaseKey(key: string): string {
    return `${this.prefix}lease:${Buffer.from(key).toString("base64url")}`;
  }

  private async mutate(mode: string, requests: readonly LockAcquireRequest[]): Promise<readonly LockLease[] | undefined> {
    if (new Set(requests.map((request) => request.key)).size !== requests.length) {
      throw new TypeError("Lock batches require unique keys.");
    }
    for (const request of requests) {
      if (!request.key || !request.ownerId || !Number.isFinite(request.ttlMs) || request.ttlMs <= 0 || Date.now() + request.ttlMs > 8_640_000_000_000_000) {
        throw new TypeError("Lock requests require a key, owner and representable positive TTL.");
      }
    }
    if (requests.length === 0) return [];
    const result = await this.client.eval(mutateLocks, {
      keys: [`${this.prefix}sequence`, ...requests.map((request) => this.leaseKey(request.key))],
      // Redis expiration has millisecond resolution; never round a lease down.
      arguments: [mode, JSON.stringify(requests.map((request) => ({ ...request, ttlMs: Math.ceil(request.ttlMs) })))],
    });
    if (result === null) return undefined;
    if (typeof result !== "string") throw new TypeError("Invalid Redis lock batch result.");
    const leases = z.array(leaseSchema).length(requests.length).parse(JSON.parse(result));
    return leases.map((lease, index) => {
      if (lease.key !== requests[index]!.key || lease.ownerId !== requests[index]!.ownerId) {
        throw new TypeError("Redis returned a different lock owner or key.");
      }
      return { key: lease.key, ownerId: lease.ownerId, expiresAt: new Date(lease.expiresAt), fencingToken: BigInt(lease.fencingToken) };
    });
  }
}
