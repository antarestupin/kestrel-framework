import { drizzle } from "drizzle-orm/node-postgres";
import {
  boolean,
  doublePrecision,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { Pool, PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createPostgresTestPool } from "../../../testing/postgres.js";
import { ThrottlingBackendUnavailableError } from "../../errors.js";
import {
  throttlingRateLimitLeases,
  throttlingRateLimits,
} from "../../postgres_schema.js";
import {
  PostgresRateLimitAdapter,
  type PostgresRateLimitDatabase,
} from "./adapter.js";

// An unqualified equivalent keeps every test on a connection-local table.
const testRateLimits = pgTable("throttling_rate_limit", {
  key: text("key").primaryKey(),
  limit: doublePrecision("limit").notNull(),
  periodMs: doublePrecision("period_ms").notNull(),
  burst: doublePrecision("burst").notNull(),
  coordinationStrategy: text("coordination_strategy").notNull().default("exact"),
  maxLeaseUnits: doublePrecision("max_lease_units"),
  leaseMs: doublePrecision("lease_ms"),
  maxOutstandingUnits: doublePrecision("max_outstanding_units"),
  guardBandUnits: doublePrecision("guard_band_units"),
  tokens: doublePrecision("tokens").notNull(),
  refilledAt: timestamp("refilled_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  fullAt: timestamp("full_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  lastAdmitted: boolean("last_admitted").notNull(),
});

const testRateLimitLeases = pgTable("throttling_rate_limit_lease", {
  id: text("id").primaryKey(),
  rateLimitKey: text("rate_limit_key").notNull(),
  ownerId: text("owner_id").notNull(),
  units: doublePrecision("units").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  returnedAt: timestamp("returned_at", { mode: "date", withTimezone: true }),
  returnedUnits: doublePrecision("returned_units").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
});

const baseRequest = {
  key: "test:partner-api",
  limit: 1,
  periodMs: 60_000,
  burst: 2,
  cost: 1,
} as const;

const leasedRequest = {
  key: "test:leased-partner-api",
  limit: 1,
  periodMs: 60_000,
  burst: 100,
  cost: 1,
  coordination: {
    strategy: "leased",
    maxLeaseUnits: 20,
    leaseMs: 5_000,
    maxOutstandingUnits: 20,
    guardBandUnits: 10,
  },
} as const;

let pool: Pool;
let client: PoolClient;
let database: PostgresRateLimitDatabase;

beforeAll(async () => {
  pool = createPostgresTestPool();
  client = await pool.connect();

  await client.query(`
    CREATE TEMPORARY TABLE throttling_rate_limit (
      key text PRIMARY KEY,
      "limit" double precision NOT NULL,
      period_ms double precision NOT NULL,
      burst double precision NOT NULL,
      coordination_strategy text NOT NULL DEFAULT 'exact',
      max_lease_units double precision,
      lease_ms double precision,
      max_outstanding_units double precision,
      guard_band_units double precision,
      tokens double precision NOT NULL,
      refilled_at timestamp with time zone NOT NULL,
      full_at timestamp with time zone NOT NULL,
      last_admitted boolean NOT NULL
    ) ON COMMIT PRESERVE ROWS
  `);
  await client.query(`
    CREATE TEMPORARY TABLE throttling_rate_limit_lease (
      id text PRIMARY KEY,
      rate_limit_key text NOT NULL,
      owner_id text NOT NULL,
      units double precision NOT NULL,
      expires_at timestamp with time zone NOT NULL,
      returned_at timestamp with time zone,
      returned_units double precision NOT NULL DEFAULT 0,
      created_at timestamp with time zone NOT NULL
    ) ON COMMIT PRESERVE ROWS
  `);
  database = drizzle(client) as PostgresRateLimitDatabase;
});

beforeEach(async () => {
  await client.query("TRUNCATE throttling_rate_limit, throttling_rate_limit_lease");
});

afterAll(async () => {
  client.release();
  await pool.end();
});

describe("PostgresRateLimitAdapter", () => {
  it("does not access storage for empty operations and preserves singleton batch outcomes", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const adapter = createAdapter({ now: () => now });
    const query = vi.spyOn(client, "query");

    try {
      await expect(adapter.reserveMany([])).resolves.toEqual({ admitted: true, remaining: {}, source: "authoritative" });
      await expect(adapter.reconcile([])).resolves.toEqual({});
      await expect(adapter.allocateLeases("worker-a", [])).resolves.toEqual({ admitted: true, allocations: {} });
      await expect(adapter.returnLeases([])).resolves.toBe(0);
      await expect(adapter.inspectMany([])).resolves.toEqual([]);
      expect(query).not.toHaveBeenCalled();

      const request = { ...baseRequest, burst: 1 };
      await expect(adapter.reserveMany([request])).resolves.toEqual({ admitted: true, remaining: { [request.key]: 0 }, source: "authoritative" });
      await holdBucketRefill(request.key);
      await expect(adapter.reserveMany([request])).resolves.toEqual({
        admitted: false, remaining: { [request.key]: 0 }, source: "authoritative",
        retryAt: new Date(now.getTime() + request.periodMs),
      });
    } finally {
      query.mockRestore();
    }
  });

  it("rolls back valid batch members when a stored policy conflicts", async () => {
    const adapter = createAdapter();
    const existing = { ...baseRequest, key: "test:existing" };
    const different = { ...existing, limit: existing.limit + 1 };
    const fresh = { ...baseRequest, key: "test:fresh" };
    const conflict = { name: "ThrottlingDefinitionConflictError", key: existing.key };
    await adapter.reserve(existing);
    await holdBucketRefill(existing.key);

    await expect(adapter.reserveMany([fresh, different])).rejects.toMatchObject(conflict);
    await expect(adapter.reconcile([
      { ...fresh, estimatedCost: 1, actualCost: 2 },
      { ...different, estimatedCost: 1, actualCost: 2 },
    ])).rejects.toMatchObject(conflict);
    await expect(adapter.inspectMany([fresh, different])).rejects.toMatchObject(conflict);
    await expect(adapter.inspectMany([fresh, existing])).resolves.toEqual([
      { available: true, remaining: 2, source: "authoritative" },
      { available: true, remaining: 1, source: "authoritative" },
    ]);
    // The valid member's insert must be rolled back, not just hidden in the response.
    const snapshot = await client.query("SELECT key, tokens FROM throttling_rate_limit");
    expect(snapshot.rows).toEqual([{ key: existing.key, tokens: 1 }]);
  });

  it("rejects a lease batch atomically and uses the longest blocked dimension's retry time", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const adapter = createAdapter({ now: () => now });
    const quick = { ...leasedRequest, key: "test:quick", periodMs: 1_000 };
    const slow = { ...leasedRequest, key: "test:slow", periodMs: 10_000 };
    const fresh = { ...leasedRequest, key: "test:fresh" };
    await adapter.allocateLeases("worker-a", [quick, slow]);
    await client.query("UPDATE throttling_rate_limit SET tokens = 0");
    await holdBucketRefill(quick.key);
    await holdBucketRefill(slow.key);

    await expect(adapter.allocateLeases("worker-b", [fresh, quick, slow])).resolves.toEqual({
      admitted: false,
      remaining: { [fresh.key]: 100, [quick.key]: 0, [slow.key]: 0 },
      retryAt: new Date(now.getTime() + 10_000),
    });
    const grants = await client.query("SELECT rate_limit_key, owner_id FROM throttling_rate_limit_lease ORDER BY rate_limit_key");
    expect(grants.rows).toEqual([
      { rate_limit_key: quick.key, owner_id: "worker-a" },
      { rate_limit_key: slow.key, owner_id: "worker-a" },
    ]);
    await expect(adapter.inspectMany([fresh])).resolves.toMatchObject([{ remaining: 100 }]);
  });

  it("retires a spent lease in the same transaction that replenishes it", async () => {
    const adapter = createAdapter();
    const first = await adapter.allocateLeases("worker-a", [leasedRequest]);
    if (!first.admitted) throw new Error("Expected an initial lease.");
    const grant = first.allocations[leasedRequest.key];
    if (grant?.mode !== "lease") throw new Error("Expected a block allocation.");
    await holdBucketRefill(leasedRequest.key);

    // Without retiring the first block, the outstanding limit would force exact fallback.
    await expect(adapter.allocateLeases("worker-a", [leasedRequest], [{
      key: leasedRequest.key, leaseId: grant.leaseId, remaining: 0,
    }])).resolves.toMatchObject({ admitted: true, allocations: {
      [leasedRequest.key]: { mode: "lease", units: 20, remaining: expect.closeTo(60, 1) },
    } });
    const leases = await client.query("SELECT returned_at, returned_units FROM throttling_rate_limit_lease WHERE id = $1", [grant.leaseId]);
    expect(leases.rows).toEqual([{ returned_at: expect.any(Date), returned_units: 0 }]);
  });

  it("charges expired leases against the same prune budget as full buckets", async () => {
    const adapter = createAdapter();
    await adapter.allocateLeases("worker-a", [leasedRequest]);
    await client.query("UPDATE throttling_rate_limit_lease SET expires_at = statement_timestamp() - interval '1 second'");
    await client.query("UPDATE throttling_rate_limit SET full_at = statement_timestamp() - interval '1 second'");

    await expect(adapter.prune({ limit: 1 })).resolves.toBe(1);
    const buckets = await client.query("SELECT key FROM throttling_rate_limit");
    expect(buckets.rows).toEqual([{ key: leasedRequest.key }]);
    await expect(adapter.prune({})).resolves.toBe(1);
    await expect(adapter.prune({})).resolves.toBe(0);
  });

  it("rejects invalid or ambiguous batch accounting inputs before querying PostgreSQL", async () => {
    const adapter = createAdapter();
    const query = vi.spyOn(client, "query");
    const returned = { key: leasedRequest.key, leaseId: "lease-1", remaining: 0 };

    try {
      await expect(adapter.reserve({ ...baseRequest, key: "" })).rejects.toThrow("keys cannot be empty");
      await expect(adapter.reserve({ ...baseRequest, limit: Number.NaN })).rejects.toThrow("limit must be a positive finite number");
      await expect(adapter.reserve({ ...baseRequest, cost: 3 })).rejects.toThrow("cost cannot exceed burst");
      await expect(adapter.reserveMany([baseRequest, baseRequest])).rejects.toThrow("is duplicated");
      await expect(adapter.reconcile([{ ...baseRequest, estimatedCost: 1, actualCost: -1 }]))
        .rejects.toThrow("actualCost must be a non-negative finite number");
      await expect(adapter.allocateLeases(" ", [leasedRequest])).rejects.toThrow("owner id cannot be empty");
      await expect(adapter.allocateLeases("owner", [leasedRequest], [{ ...returned, key: "unrelated" }]))
        .rejects.toThrow("Completed leases must belong to the allocation request keys");
      for (const [coordination, message] of [
        [{ leaseMs: 0 }, "leaseMs must be positive and finite"],
        [{ guardBandUnits: -1 }, "guardBandUnits must be non-negative and finite"],
        [{ maxLeaseUnits: 101 }, "maxLeaseUnits cannot exceed burst"],
        [{ maxOutstandingUnits: 19 }, "maxOutstandingUnits cannot be smaller than maxLeaseUnits"],
      ] as const) {
        await expect(adapter.allocateLeases("owner", [{
          ...leasedRequest, coordination: { ...leasedRequest.coordination, ...coordination },
        }])).rejects.toThrow(message);
      }
      await expect(adapter.returnLeases([{ ...returned, leaseId: "" }])).rejects.toThrow("lease identifiers cannot be empty");
      await expect(adapter.returnLeases([{ ...returned, remaining: -1 }])).rejects.toThrow("remaining units must be non-negative");
      await expect(adapter.returnLeases([returned, returned])).rejects.toThrow("is duplicated");
      await expect(adapter.prune({ limit: 0 })).rejects.toThrow("prune limit must be a positive integer");
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });

  it.each([
    [{ maxConcurrentReservations: 0 }, "maxConcurrentReservations must be a positive integer"],
    [{ maxPendingReservations: -1 }, "maxPendingReservations must be a non-negative integer"],
    [{ storageWaitTimeoutMs: Number.POSITIVE_INFINITY }, "storageWaitTimeoutMs must be positive and finite"],
  ] as const)("rejects invalid storage queue settings (%j)", (options, message) => {
    expect(() => createAdapter(options)).toThrow(message);
  });

  it("bounds queued reservations and recovers after a timeout", async () => {
    const entered = Promise.withResolvers<void>();
    const firstResult = Promise.withResolvers<{ rows: object[] }>();
    const backend = { execute: vi.fn(() => { entered.resolve(); return firstResult.promise; }) };
    const adapter = new PostgresRateLimitAdapter(backend as unknown as PostgresRateLimitDatabase, {
      maxConcurrentReservations: 1, maxPendingReservations: 1, storageWaitTimeoutMs: 5,
    });
    const first = adapter.reserve(baseRequest);
    await entered.promise;
    const second = adapter.reserve(baseRequest);
    const timedOut = expect(second).rejects.toMatchObject({ cause: expect.objectContaining({ message: "Timed out waiting for throttling storage capacity." }) });
    try {
      await expect(adapter.reserve(baseRequest)).rejects.toMatchObject({ cause: expect.objectContaining({ message: "The throttling storage queue is full." }) });
      await timedOut;
      expect(backend.execute).toHaveBeenCalledTimes(1);
    } finally {
      firstResult.resolve({ rows: [{ key: baseRequest.key, admitted: true, remaining: 1 }] });
      await first;
    }
    await expect(adapter.reserve(baseRequest)).resolves.toMatchObject({ admitted: true, remaining: 1 });
    expect(backend.execute).toHaveBeenCalledTimes(2);
  });

  it("normalizes invalid query replies and database failures as backend unavailability", async () => {
    const backend = { execute: vi.fn() };
    const adapter = new PostgresRateLimitAdapter(backend as unknown as PostgresRateLimitDatabase);
    backend.execute.mockResolvedValueOnce({ rows: [{ key: baseRequest.key, position: 2, remaining: 1 }] });
    await expect(adapter.inspectMany([baseRequest])).rejects.toMatchObject({
      name: "ThrottlingBackendUnavailableError",
      cause: expect.objectContaining({ message: "PostgreSQL returned an invalid inspection position." }),
    });

    const storageFailure = new Error("database disconnected");
    backend.execute.mockRejectedValueOnce(storageFailure);
    const result = adapter.reserve(baseRequest);
    await expect(result).rejects.toBeInstanceOf(ThrottlingBackendUnavailableError);
    await expect(result).rejects.toHaveProperty("cause", storageFailure);
  });

  it("serializes concurrent admissions for one global burst", async () => {
    const adapter = createAdapter();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => adapter.reserve(baseRequest)),
    );

    expect(results.filter((result) => result.admitted)).toHaveLength(2);
    expect(results.filter((result) => !result.admitted)).toHaveLength(3);
  });

  it("deducts one unit per sequential admission from a larger burst", async () => {
    const adapter = createAdapter();
    const request = {
      ...baseRequest,
      limit: 5,
      periodMs: 60_000,
      burst: 5,
    };

    await expect(adapter.reserve(request)).resolves.toMatchObject({
      admitted: true,
      remaining: 4,
    });
    await expect(adapter.reserve(request)).resolves.toMatchObject({
      admitted: true,
      remaining: expect.closeTo(3, 2),
    });
    await expect(adapter.reserve(request)).resolves.toMatchObject({
      admitted: true,
      remaining: expect.closeTo(2, 2),
    });
  });

  it("refills continuously using PostgreSQL time", async () => {
    const adapter = createAdapter();
    const request = { ...baseRequest, limit: 2, burst: 1 };

    await expect(adapter.reserve(request)).resolves.toMatchObject({
      admitted: true,
      remaining: 0,
    });
    await client.query(`
      UPDATE throttling_rate_limit
      SET refilled_at = statement_timestamp() - interval '30 seconds'
    `);

    await expect(adapter.reserve(request)).resolves.toMatchObject({
      admitted: true,
      remaining: expect.closeTo(0, 2),
    });
  });

  it("rejects incompatible policies sharing one storage key", async () => {
    const adapter = createAdapter();

    await adapter.reserve(baseRequest);

    await expect(adapter.reserve({ ...baseRequest, limit: 2 }))
      .rejects.toMatchObject({
        name: "ThrottlingDefinitionConflictError",
        key: baseRequest.key,
      });
  });

  it("prunes only fully refilled buckets in bounded batches", async () => {
    const adapter = createAdapter();

    await client.query(`
      INSERT INTO throttling_rate_limit (
        key, "limit", period_ms, burst, tokens,
        refilled_at, full_at, last_admitted
      ) VALUES
        ('test:full', 1, 1000, 1, 0, statement_timestamp(),
          statement_timestamp() - interval '1 second', true),
        ('test:active', 1, 1000, 1, 0, statement_timestamp(),
          statement_timestamp() + interval '1 minute', true)
    `);

    await expect(adapter.prune({ limit: 1 })).resolves.toBe(1);
    await expect(adapter.prune({ limit: 1 })).resolves.toBe(0);

    const remaining = await client.query<{ key: string }>(
      "SELECT key FROM throttling_rate_limit",
    );
    expect(remaining.rows).toEqual([{ key: "test:active" }]);
  });

  it("rolls back every dimension when one atomic reservation rejects", async () => {
    const adapter = createAdapter();
    const first = { ...baseRequest, key: "test:first", burst: 1 };
    const exhausted = { ...baseRequest, key: "test:exhausted", burst: 1 };

    await adapter.reserve(exhausted);

    await expect(adapter.reserveMany([first, exhausted])).resolves.toMatchObject({
      admitted: false,
      source: "authoritative",
    });
    await expect(adapter.reserve(first)).resolves.toMatchObject({
      admitted: true,
      remaining: 0,
    });
  });

  it("commits every dimension together and inspects without mutation", async () => {
    const adapter = createAdapter();
    const first = { ...baseRequest, key: "test:first" };
    const second = { ...baseRequest, key: "test:second" };

    await expect(adapter.inspectMany([first, second])).resolves.toMatchObject([
      { available: true, remaining: 2 },
      { available: true, remaining: 2 },
    ]);
    const before = await client.query<{ count: string }>(
      "SELECT count(*) FROM throttling_rate_limit",
    );
    expect(before.rows[0]?.count).toBe("0");

    await expect(adapter.reserveMany([first, second])).resolves.toMatchObject({
      admitted: true,
      remaining: { "test:first": 1, "test:second": 1 },
    });
  });

  it("creates debt when actual cost exceeds the estimate", async () => {
    const adapter = createAdapter();
    const request = {
      ...baseRequest,
      key: "test:tokens",
      limit: 10,
      burst: 10,
      cost: 6,
    };

    await adapter.reserve(request);
    await holdBucketRefill(request.key);
    await expect(adapter.reconcile([{
      ...request,
      estimatedCost: 6,
      actualCost: 12,
    }])).resolves.toMatchObject({ "test:tokens": -2 });
    await expect(adapter.inspectMany([{ ...request, cost: 1 }]))
      .resolves.toMatchObject([{
        available: false,
        remaining: -2,
        retryAt: expect.any(Date),
      }]);
  });

  it("refunds unused estimated cost up to burst capacity", async () => {
    const adapter = createAdapter();
    const request = {
      ...baseRequest,
      key: "test:tokens",
      limit: 10,
      burst: 10,
      cost: 6,
    };

    await adapter.reserve(request);
    await holdBucketRefill(request.key);
    await expect(adapter.reconcile([{
      ...request,
      estimatedCost: 6,
      actualCost: 2,
    }])).resolves.toMatchObject({ "test:tokens": 8 });
    await expect(adapter.reserve({ ...request, cost: 8 }))
      .resolves.toMatchObject({ admitted: true });
  });

  it("uses bounded set-based PostgreSQL command counts", async () => {
    const adapter = createAdapter();
    const first = { ...baseRequest, key: "test:commands:first" };
    const second = { ...baseRequest, key: "test:commands:second" };
    const query = vi.spyOn(client, "query");

    try {
      await adapter.reserve(first);
      expect(query).toHaveBeenCalledTimes(1);

      query.mockClear();
      await adapter.reserve(first);
      expect(query).toHaveBeenCalledTimes(1);

      query.mockClear();
      await adapter.reserveMany([first, second]);
      expect(query).toHaveBeenCalledTimes(3);

      query.mockClear();
      await adapter.inspectMany([first, second]);
      expect(query).toHaveBeenCalledTimes(1);

      query.mockClear();
      await adapter.reconcile([
        { ...first, estimatedCost: 1, actualCost: 0.5 },
        { ...second, estimatedCost: 1, actualCost: 0.5 },
      ]);
      expect(query).toHaveBeenCalledTimes(3);

      query.mockClear();
      await adapter.allocateLeases("worker-a", [leasedRequest]);
      expect(query).toHaveBeenCalledTimes(6);
    } finally {
      query.mockRestore();
    }
  });

  it("issues a bounded lease and falls back to an exact reservation when outstanding capacity is capped", async () => {
    const adapter = createAdapter();
    const first = await adapter.allocateLeases("worker-a", [leasedRequest]);

    expect(first).toMatchObject({
      admitted: true,
      allocations: {
        [leasedRequest.key]: {
          mode: "lease",
          units: 20,
          remaining: 80,
        },
      },
    });

    await expect(adapter.allocateLeases("worker-b", [leasedRequest]))
      .resolves.toMatchObject({
        admitted: true,
        allocations: {
          [leasedRequest.key]: {
            mode: "exact",
            remaining: expect.closeTo(79, 1),
          },
        },
      });
  });

  it("returns unused lease units once and rejects incompatible lease definitions", async () => {
    const adapter = createAdapter();
    const allocation = await adapter.allocateLeases("worker-a", [leasedRequest]);
    expect(allocation.admitted).toBe(true);
    if (!allocation.admitted) return;
    const grant = allocation.allocations[leasedRequest.key];
    expect(grant?.mode).toBe("lease");
    if (grant?.mode !== "lease") return;

    const returned = [{
      key: leasedRequest.key,
      leaseId: grant.leaseId,
      remaining: 15,
    }];
    await expect(adapter.returnLeases(returned)).resolves.toBe(1);
    await expect(adapter.returnLeases(returned)).resolves.toBe(0);
    await expect(adapter.inspectMany([{ ...leasedRequest, cost: 94 }]))
      .resolves.toMatchObject([{ available: true }]);

    await expect(adapter.allocateLeases("worker-b", [{
      ...leasedRequest,
      coordination: { ...leasedRequest.coordination, maxLeaseUnits: 10 },
    }])).rejects.toMatchObject({
      name: "ThrottlingDefinitionConflictError",
      key: leasedRequest.key,
    });
  });

  it("does not count expired grants as outstanding or refund them implicitly", async () => {
    const adapter = createAdapter();
    await adapter.allocateLeases("worker-a", [leasedRequest]);
    await client.query(`
      UPDATE throttling_rate_limit_lease
      SET expires_at = statement_timestamp() - interval '1 second'
    `);

    await expect(adapter.allocateLeases("worker-b", [leasedRequest]))
      .resolves.toMatchObject({
        admitted: true,
        allocations: {
          [leasedRequest.key]: { mode: "lease", units: 20 },
        },
      });
    const bucket = await client.query<{ tokens: number }>(
      "SELECT tokens FROM throttling_rate_limit WHERE key = $1",
      [leasedRequest.key],
    );
    expect(bucket.rows[0]?.tokens).toBeLessThan(61);
  });

  it("keeps buckets with active leases and refuses late refunds after expiry", async () => {
    const adapter = createAdapter();
    const allocation = await adapter.allocateLeases("worker-a", [leasedRequest]);
    expect(allocation.admitted).toBe(true);
    if (!allocation.admitted) return;
    const grant = allocation.allocations[leasedRequest.key];
    expect(grant?.mode).toBe("lease");
    if (grant?.mode !== "lease") return;

    await client.query(`
      UPDATE throttling_rate_limit
      SET full_at = statement_timestamp() - interval '1 second'
    `);
    await expect(adapter.prune({ limit: 10 })).resolves.toBe(0);

    await client.query(`
      UPDATE throttling_rate_limit_lease
      SET expires_at = statement_timestamp() - interval '1 second'
    `);
    await expect(adapter.returnLeases([{
      key: leasedRequest.key,
      leaseId: grant.leaseId,
      remaining: grant.units,
    }])).resolves.toBe(1);
    const bucket = await client.query<{ tokens: number }>(
      "SELECT tokens FROM throttling_rate_limit WHERE key = $1",
      [leasedRequest.key],
    );
    expect(bucket.rows[0]?.tokens).toBeLessThan(81);
  });
});

/** Isolate reconciliation arithmetic from real PostgreSQL refill time under concurrent CI load. */
async function holdBucketRefill(key: string): Promise<void> {
  await client.query(`
    UPDATE throttling_rate_limit
    SET refilled_at = statement_timestamp() + interval '1 day'
    WHERE key = $1
  `, [key]);
}

function createAdapter(
  options: ConstructorParameters<typeof PostgresRateLimitAdapter>[1] = {},
): PostgresRateLimitAdapter {
  return new PostgresRateLimitAdapter(
    database,
    { maxConcurrentReservations: 1, ...options },
    testRateLimits as unknown as typeof throttlingRateLimits,
    testRateLimitLeases as unknown as typeof throttlingRateLimitLeases,
  );
}
