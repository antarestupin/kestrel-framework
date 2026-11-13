import { randomUUID } from "node:crypto";
import { setImmediate, setTimeout as pause } from "node:timers/promises";
import { sql } from "drizzle-orm";
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
import {
  ThrottlingBackendUnavailableError,
  ThrottlingDefinitionConflictError,
} from "../../errors.js";
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
    const transaction = vi.spyOn(database, "transaction");

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
      await expect(adapter.reconcile([{ ...request, estimatedCost: 1, actualCost: 0 }])).resolves.toEqual({ [request.key]: 1 });
      // Single-statement reservations and adjustments need no transaction round trip.
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
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

  it("returns completed capacity even when there are no new lease requests", async () => {
    const adapter = createAdapter();
    const allocated = await adapter.allocateLeases("worker-a", [leasedRequest]);
    if (!allocated.admitted) throw new Error("Expected an initial grant.");
    const grant = allocated.allocations[leasedRequest.key];
    if (grant?.mode !== "lease") throw new Error("Expected a block allocation.");
    await holdBucketRefill(leasedRequest.key);
    const returned = { key: leasedRequest.key, leaseId: grant.leaseId, remaining: 5 };

    await expect(adapter.allocateLeases("worker-a", [], [returned])).resolves.toEqual({ admitted: true, allocations: {} });
    await expect(adapter.returnLeases([returned])).resolves.toBe(0);
    await holdBucketRefill(leasedRequest.key);
    await expect(adapter.inspectMany([leasedRequest])).resolves.toEqual([
      { available: true, remaining: 85, source: "authoritative" },
    ]);
  });

  it("charges expired leases against the same prune budget as full buckets", async () => {
    const adapter = createAdapter();
    await adapter.allocateLeases("worker-a", [leasedRequest]);
    await client.query("UPDATE throttling_rate_limit_lease SET expires_at = statement_timestamp() - interval '1 second'");
    await client.query("UPDATE throttling_rate_limit SET full_at = statement_timestamp() - interval '1 second'");

    const query = vi.spyOn(client, "query");
    try {
      await expect(adapter.prune({ limit: 1 })).resolves.toBe(1);
      expect(query).toHaveBeenCalledOnce();
    } finally {
      query.mockRestore();
    }
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
      await expect(adapter.reconcile([{ ...baseRequest, cost: 0, estimatedCost: 1, actualCost: 0 }]))
        .rejects.toThrow("cost must be a positive finite number");
      await expect(adapter.inspectMany([{ ...baseRequest, key: "" }])).rejects.toThrow("keys cannot be empty");
      await expect(adapter.allocateLeases(" ", [leasedRequest])).rejects.toThrow("owner id cannot be empty");
      await expect(adapter.allocateLeases("owner", [{ ...leasedRequest, key: "" }])).rejects.toThrow("keys cannot be empty");
      await expect(adapter.allocateLeases("owner", [leasedRequest], [{ ...returned, leaseId: "" }]))
        .rejects.toThrow("lease identifiers cannot be empty");
      await expect(Reflect.apply(adapter.allocateLeases, adapter, ["owner", [{ ...leasedRequest, coordination: { strategy: "exact" } }]]))
        .rejects.toThrow("Lease allocation requires leased coordination");
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
      await expect(adapter.returnLeases([{ ...returned, key: "" }])).rejects.toThrow("lease identifiers cannot be empty");
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
    [{ storageWaitTimeoutMs: 0 }, "storageWaitTimeoutMs must be positive and finite"],
  ] as const)("rejects invalid storage queue settings (%j)", (options, message) => {
    expect(() => createAdapter(options)).toThrow(message);
  });

  it("bounds queued reservations and recovers after a timeout", async () => {
    const firstResult = Promise.withResolvers<{ rows: object[] }>();
    const backend = { execute: vi.fn(() => firstResult.promise) };
    const adapter = new PostgresRateLimitAdapter(backend as unknown as PostgresRateLimitDatabase, {
      maxConcurrentReservations: 1, maxPendingReservations: 1, storageWaitTimeoutMs: 5,
    });
    const holder = vi.fn();
    const queued = vi.fn();
    const overflowing = vi.fn();
    const later = vi.fn();
    const row = { rows: [{ key: baseRequest.key, admitted: true, remaining: 1 }] };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      void adapter.reserve(baseRequest).then(holder, holder);
      await vi.advanceTimersByTimeAsync(0);
      expect(backend.execute).toHaveBeenCalledOnce();
      void adapter.reserve(baseRequest).then(queued, queued);
      void adapter.reserve(baseRequest).then(overflowing, overflowing);
      await vi.advanceTimersByTimeAsync(0);
      expect(overflowing).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cause: expect.objectContaining({ message: "The throttling storage queue is full." }) }));
      expect(queued).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5);
      expect(queued).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cause: expect.objectContaining({ message: "Timed out waiting for throttling storage capacity." }) }));
      expect(backend.execute).toHaveBeenCalledOnce();

      firstResult.resolve(row);
      await vi.advanceTimersByTimeAsync(0);
      expect(holder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ admitted: true, remaining: 1 }));
      void adapter.reserve(baseRequest).then(later, later);
      await vi.advanceTimersByTimeAsync(0);
      expect(later).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ admitted: true, remaining: 1 }));
      expect(backend.execute).toHaveBeenCalledTimes(2);
    } finally {
      firstResult.resolve(row);
      try {
        await vi.advanceTimersByTimeAsync(5);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("hands capacity to a live waiter after an earlier waiter expires", async () => {
    const first = Promise.withResolvers<{ rows: object[] }>();
    const second = Promise.withResolvers<{ rows: object[] }>();
    const row = { rows: [{ key: baseRequest.key, admitted: true, remaining: 1 }] };
    const execute = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(row);
    const adapter = new PostgresRateLimitAdapter({ execute } as unknown as PostgresRateLimitDatabase, {
      maxConcurrentReservations: 1, maxPendingReservations: 2, storageWaitTimeoutMs: 10,
    });
    const holder = vi.fn();
    const expired = vi.fn();
    const live = vi.fn();
    const last = vi.fn();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      void adapter.reserve(baseRequest).then(holder, holder);
      void adapter.reserve(baseRequest).then(expired, expired);
      await vi.advanceTimersByTimeAsync(5);
      void adapter.reserve(baseRequest).then(live, live);
      await vi.advanceTimersByTimeAsync(5);

      expect(expired).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        cause: expect.objectContaining({ message: "Timed out waiting for throttling storage capacity." }),
      }));
      expect(live).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);

      // The expired entry must not absorb the handoff, and the live waiter owns the only slot.
      first.resolve(row);
      await vi.advanceTimersByTimeAsync(0);
      expect(holder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ admitted: true }));
      expect(execute).toHaveBeenCalledTimes(2);
      void adapter.reserve(baseRequest).then(last, last);
      await vi.advanceTimersByTimeAsync(0);
      expect(last).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(2);

      second.resolve(row);
      await vi.advanceTimersByTimeAsync(0);
      expect(live).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ admitted: true }));
      expect(last).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ admitted: true }));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      first.resolve(row);
      second.resolve(row);
      try {
        await vi.advanceTimersByTimeAsync(20);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("keeps a valid long storage wait pending until a pool slot becomes available", async () => {
    const first = Promise.withResolvers<{ rows: object[] }>();
    const row = { rows: [{ key: baseRequest.key, admitted: true, remaining: 1 }] };
    const execute = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(row);
    const adapter = new PostgresRateLimitAdapter({ execute } as unknown as PostgresRateLimitDatabase, {
      maxConcurrentReservations: 1, maxPendingReservations: 1, storageWaitTimeoutMs: 2_147_483_648,
    });
    const warning = vi.spyOn(process, "emitWarning");
    const timer = vi.spyOn(globalThis, "setTimeout");
    const holding = adapter.reserve(baseRequest);
    const queued = adapter.reserve(baseRequest);
    const settled = vi.fn();
    void queued.then(settled, settled);
    try {
      await setImmediate();
      expect(warning.mock.calls.some(([message]) => String(message).includes("does not fit into a 32-bit signed integer"))).toBe(false);
      // An outstanding storage waiter owns its deadline while a reservation occupies the pool.
      const deadlineTimer = timer.mock.calls.findIndex(([, delay]) => delay === 2_147_483_647);
      expect(timer.mock.results[deadlineTimer]?.value.hasRef()).toBe(true);
      expect(settled).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
      first.resolve(row);
      await expect(queued).resolves.toMatchObject({ admitted: true });
    } finally {
      warning.mockRestore();
      timer.mockRestore();
      first.resolve(row);
      await Promise.allSettled([holding, queued]);
    }
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

  it("normalizes backend errors for returns and pruning, and rejects an invalid retry clock", async () => {
    const cause = new Error("backend disconnected");
    const failedBackend = { execute: vi.fn().mockRejectedValue(cause), transaction: vi.fn().mockRejectedValue(cause) };
    const disconnected = new PostgresRateLimitAdapter(failedBackend as unknown as PostgresRateLimitDatabase);
    await expect(disconnected.returnLeases([{ key: "quota", leaseId: "grant", remaining: 0 }]))
      .rejects.toMatchObject({ name: "ThrottlingBackendUnavailableError", cause });
    await expect(disconnected.prune({})).rejects.toMatchObject({ name: "ThrottlingBackendUnavailableError", cause });

    const adapter = createAdapter({ now: () => new Date(NaN), maxPendingReservations: 0 });
    await expect(adapter.reserve(baseRequest)).resolves.toEqual({ admitted: true, remaining: 1, source: "authoritative" });
    await holdBucketRefill(baseRequest.key);
    await expect(adapter.reserve({ ...baseRequest, cost: 2 })).rejects.toMatchObject({
      name: "ThrottlingBackendUnavailableError", cause: expect.objectContaining({ message: "The throttling clock returned an invalid date." }),
    });
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

  it("rolls back every dimension and reports the latest retry for a rejected atomic reservation", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const adapter = createAdapter({ now: () => now });
    const fresh = { ...baseRequest, key: "test:fresh", burst: 1 };
    const quick = { ...baseRequest, key: "test:quick", limit: 2, periodMs: 1_000 };
    const slow = { ...baseRequest, key: "test:slow", limit: 3, periodMs: 3_001 };
    for (const request of [quick, slow]) {
      await adapter.reserve({ ...request, cost: 1.5 });
      await holdBucketRefill(request.key);
    }

    // The admitted dimension uses all its tentative capacity, but contributes no retry delay.
    await expect(adapter.reserveMany([fresh, slow, quick])).resolves.toEqual({
      admitted: false,
      remaining: { [fresh.key]: 0, [quick.key]: 0.5, [slow.key]: 0.5 },
      retryAt: new Date(now.getTime() + 501),
      source: "authoritative",
    });
    const snapshot = await client.query("SELECT key, tokens FROM throttling_rate_limit ORDER BY key");
    expect(snapshot.rows).toEqual([{ key: quick.key, tokens: 0.5 }, { key: slow.key, tokens: 0.5 }]);
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
      source: "authoritative",
    });
  });

  it("uses the persisted exact coordination mode across deployments", async () => {
    const adapter = createAdapter();
    // Seed the schema's default without going through the adapter being tested.
    await database.insert(testRateLimits).values({
      ...baseRequest,
      tokens: 1,
      refilledAt: new Date("2100-01-01T00:00:00Z"),
      fullAt: new Date("2100-01-01T00:01:00Z"),
      lastAdmitted: true,
    });

    await expect(adapter.reserveMany([baseRequest])).resolves.toEqual({
      admitted: true, remaining: { [baseRequest.key]: 0 }, source: "authoritative",
    });
    await expect(adapter.reserve(baseRequest)).resolves.toMatchObject({
      admitted: false, remaining: 0, source: "authoritative",
    });
  });

  it("rejects singleton reconciliation against an incompatible stored policy", async () => {
    const adapter = createAdapter();
    await adapter.reserve(baseRequest);
    await holdBucketRefill(baseRequest.key);
    await expect(adapter.reconcile([{
      ...baseRequest, limit: 2, estimatedCost: 1, actualCost: 2,
    }])).rejects.toMatchObject({
      name: ThrottlingDefinitionConflictError.name, key: baseRequest.key,
    });
    await expect(adapter.inspectMany([baseRequest])).resolves.toMatchObject([{ remaining: 1 }]);
  });

  it("returns each reconciled dimension's own committed capacity", async () => {
    const adapter = createAdapter();
    const first = { ...baseRequest, key: "test:usage:first" };
    const second = { ...baseRequest, key: "test:usage:second" };
    await adapter.reserveMany([first, second]);
    await holdBucketRefill(first.key);
    await holdBucketRefill(second.key);

    const remaining = await adapter.reconcile([
      { ...second, estimatedCost: 1, actualCost: 1.5 },
      { ...first, estimatedCost: 1, actualCost: 0 },
    ]);
    expect(remaining).toEqual({ [first.key]: 2, [second.key]: 0.5 });
    await expect(adapter.inspectMany([first, second])).resolves.toMatchObject([
      { remaining: 2 }, { remaining: 0.5 },
    ]);
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

  it("charges the full request exactly when it costs more than a lease can hold", async () => {
    const adapter = createAdapter();
    const request = {
      ...leasedRequest,
      cost: 25,
      coordination: { ...leasedRequest.coordination, maxOutstandingUnits: 40 },
    };

    await expect(adapter.allocateLeases("worker-a", [request])).resolves.toEqual({
      admitted: true,
      allocations: { [request.key]: { mode: "exact", remaining: 75 } },
    });
    const grants = await client.query("SELECT id FROM throttling_rate_limit_lease");
    expect(grants.rows).toEqual([]);
  });

  it("rejects exhausted tiny capacity without issuing a second exact reservation", async () => {
    const adapter = createAdapter();
    const cost = Number.EPSILON;
    const request = { ...leasedRequest, limit: cost, cost, burst: cost, coordination: {
      ...leasedRequest.coordination, maxLeaseUnits: cost, maxOutstandingUnits: cost, guardBandUnits: 0,
    } };
    await expect(adapter.allocateLeases("worker", [request])).resolves.toMatchObject({ admitted: true });
    await holdBucketRefill(request.key);

    await expect(adapter.allocateLeases("worker", [request])).resolves.toMatchObject({ admitted: false, remaining: { [request.key]: 0 } });
    await expect(adapter.inspectMany([request])).resolves.toMatchObject([{ available: false, remaining: 0 }]);
  });

  it("accepts cost equal to available units, lease size equal to burst, and a zero guard band", async () => {
    const adapter = createAdapter();
    const exact = { ...baseRequest, cost: 2 };
    const fullBlock = { ...leasedRequest, cost: 20, coordination: { ...leasedRequest.coordination, guardBandUnits: 0 } };
    const capped = { ...leasedRequest, key: "test:cap", burst: 20, cost: 20, coordination: { ...leasedRequest.coordination, guardBandUnits: 0 } };

    await expect(adapter.inspectMany([exact])).resolves.toEqual([{ available: true, remaining: 2, source: "authoritative" }]);
    await expect(adapter.allocateLeases("worker-a", [fullBlock, capped])).resolves.toMatchObject({
      admitted: true,
      allocations: { [fullBlock.key]: { mode: "lease", units: 20, remaining: 80 }, [capped.key]: { mode: "exact", remaining: 0 } },
    });
    await adapter.reconcile([{ ...exact, estimatedCost: 2, actualCost: 0 }]);
    await expect(adapter.inspectMany([exact])).resolves.toEqual([{ available: true, remaining: 2, source: "authoritative" }]);
  });

  it("uses exact allocation at the guard-band boundary and leases just above it", async () => {
    const adapter = createAdapter();
    const boundary = { ...leasedRequest, key: "test:guard-boundary" };
    const above = { ...leasedRequest, key: "test:above-guard" };
    const threshold = leasedRequest.coordination.guardBandUnits + leasedRequest.cost;
    await adapter.allocateLeases("initial", [boundary, above]);
    // Remove the first grants so only available capacity governs the next allocation mode.
    await client.query("DELETE FROM throttling_rate_limit_lease");
    await client.query("UPDATE throttling_rate_limit SET tokens = $1 WHERE key = $2", [threshold, boundary.key]);
    await client.query("UPDATE throttling_rate_limit SET tokens = $1 WHERE key = $2", [threshold + 0.5, above.key]);
    await holdBucketRefill(boundary.key);
    await holdBucketRefill(above.key);

    await expect(adapter.allocateLeases("next", [boundary, above])).resolves.toMatchObject({
      admitted: true,
      allocations: {
        [boundary.key]: { mode: "exact", remaining: 10 },
        [above.key]: { mode: "lease", units: 1.5, remaining: 10 },
      },
    });
  });

  it("uses exact allocation when fractional capacity is within rounding distance of the guard band", async () => {
    const adapter = createAdapter();
    const boundary = { ...leasedRequest, key: "test:fractional-guard", cost: 0.25,
      coordination: { ...leasedRequest.coordination, guardBandUnits: 0 } };
    await adapter.allocateLeases("initial", [boundary]);
    await client.query("DELETE FROM throttling_rate_limit_lease");
    await client.query("UPDATE throttling_rate_limit SET tokens = $1 WHERE key = $2", [0.25 + Number.EPSILON / 2, boundary.key]);
    await holdBucketRefill(boundary.key);

    // A rounding-sized surplus must not switch the allocation mode to a lease.
    await expect(adapter.allocateLeases("next", [boundary])).resolves.toMatchObject({
      admitted: true, allocations: { [boundary.key]: { mode: "exact" } },
    });
  });

  it("reads active lease capacity after waiting for a different connection's row lock", async () => {
    await withSharedLeaseTables(async (owner, peer) => {
      let pending: Promise<PromiseSettledResult<Awaited<ReturnType<PostgresRateLimitAdapter["allocateLeases"]>>>> | undefined;
      const [ownerPid, peerPid] = await Promise.all([owner, peer].map(async (connection) =>
        (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid));
      const ownerDb = drizzle(owner);
      const adapter = createAdapter({}, drizzle(peer) as PostgresRateLimitDatabase);
      const { key, limit, periodMs, burst, coordination } = leasedRequest;
      const refilledAt = new Date("2100-01-01T00:00:00Z");
      await ownerDb.insert(testRateLimits).values({
        key, limit, periodMs, burst,
        coordinationStrategy: coordination.strategy,
        maxLeaseUnits: coordination.maxLeaseUnits,
        leaseMs: coordination.leaseMs,
        maxOutstandingUnits: coordination.maxOutstandingUnits,
        guardBandUnits: coordination.guardBandUnits,
        tokens: burst, refilledAt, fullAt: refilledAt, lastAdmitted: true,
      });

      try {
        const blockedStatement = await ownerDb.transaction(async (transaction) => {
          // Lock the pre-existing row before the peer reads capacity. Its snapshot must follow this commit.
          await transaction.execute(sql`SELECT key FROM throttling_rate_limit WHERE key = ${key} FOR UPDATE`);
          let settled = false;
          pending = Promise.allSettled([adapter.allocateLeases("peer", [leasedRequest])]).then(([result]) => {
            settled = true;
            return result!;
          });
          const statement = await observeBlockedStatement(ownerPid!, peerPid!, () => settled);
          await transaction.update(testRateLimits).set({ tokens: burst - coordination.maxLeaseUnits })
            .where(sql`${testRateLimits.key} = ${key}`);
          await transaction.insert(testRateLimitLeases).values({
            id: "owner-grant", rateLimitKey: key, ownerId: "owner", units: coordination.maxLeaseUnits,
            expiresAt: refilledAt, createdAt: new Date(),
          });
          return statement;
        });

        // Waiting on a later UPDATE would be too late because the allocation decision would already be stale.
        expect(blockedStatement).toMatch(/FOR UPDATE OF/i);
        await expect(pending).resolves.toEqual({
          status: "fulfilled",
          value: { admitted: true, allocations: { [key]: { mode: "exact", remaining: 79 } } },
        });
        const active = await owner.query("SELECT owner_id, units FROM throttling_rate_limit_lease");
        expect(active.rows).toEqual([{ owner_id: "owner", units: coordination.maxLeaseUnits }]);
      } finally {
        await pending;
      }
    });
  });

  it("preserves the latest refill clock when a lease return waits for a bucket update", async () => {
    await withSharedLeaseTables(async (owner, peer) => {
      const ownerDb = drizzle(owner);
      const adapter = createAdapter({}, drizzle(peer) as PostgresRateLimitDatabase);
      const { key, burst, periodMs, limit } = leasedRequest;
      const allocation = await adapter.allocateLeases("peer", [leasedRequest]);
      const grant = allocation.admitted ? allocation.allocations[key] : undefined;
      if (grant?.mode !== "lease") throw new Error("Expected a leased grant.");
      const [ownerPid, peerPid] = await Promise.all([owner, peer].map(async (connection) =>
        (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid));
      let pending: Promise<PromiseSettledResult<number>> | undefined;

      try {
        const latest = await ownerDb.transaction(async (transaction) => {
          await transaction.execute(sql`SELECT key FROM throttling_rate_limit WHERE key = ${key} FOR UPDATE`);
          let settled = false;
          pending = Promise.allSettled([adapter.returnLeases([
            { key, leaseId: grant.leaseId, remaining: 2 },
          ])]).then(([result]) => {
            settled = true;
            return result!;
          });
          expect(await observeBlockedStatement(ownerPid!, peerPid!, () => settled)).toMatch(/FOR UPDATE OF/i);

          // The owner advances the refill clock in a later statement while holding the lock.
          const writer = createAdapter({}, transaction as unknown as PostgresRateLimitDatabase);
          const balance = await writer.reconcile([{ ...leasedRequest, estimatedCost: 1, actualCost: 2 }]);
          const { rows } = await transaction.execute(sql`
            SELECT refilled_at::text FROM throttling_rate_limit WHERE key = ${key}
          `);
          return { balance: balance[key]!, refilledAt: rows[0]!.refilled_at };
        });

        await expect(pending).resolves.toEqual({ status: "fulfilled", value: 1 });
        const { rows } = await owner.query<{
          refilled_at: string;
          tokens: number;
          milliseconds_until_full: string;
        }>(`
          SELECT refilled_at::text, tokens,
            EXTRACT(EPOCH FROM (full_at - refilled_at)) * 1000 AS milliseconds_until_full
          FROM throttling_rate_limit WHERE key = $1
        `, [key]);
        expect(rows[0]?.refilled_at).toBe(latest.refilledAt);
        expect(rows[0]?.tokens).toBeCloseTo(latest.balance + 2, 8);
        expect(Number(rows[0]?.milliseconds_until_full))
          .toBeCloseTo((burst - latest.balance - 2) * periodMs / limit, 2);
      } finally {
        await pending;
      }
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

/** Gives both connections access to the same tables in an owned test schema. */
async function withSharedLeaseTables(
  use: (owner: PoolClient, peer: PoolClient) => Promise<void>,
): Promise<void> {
  const schema = `throttling_race_${randomUUID().replaceAll("-", "")}`;
  let owner: PoolClient | undefined;
  let peer: PoolClient | undefined;
  await client.query(`CREATE SCHEMA "${schema}"`);

  try {
    for (const table of ["throttling_rate_limit", "throttling_rate_limit_lease"]) {
      await client.query(`CREATE TABLE "${schema}".${table} (LIKE pg_temp.${table} INCLUDING ALL)`);
    }
    owner = await pool.connect();
    peer = await pool.connect();
    for (const connection of [owner, peer]) {
      await connection.query(`SET search_path TO "${schema}"`);
      await connection.query("SET statement_timeout = '2s'");
    }
    await use(owner, peer);
  } finally {
    peer?.release(true);
    owner?.release(true);
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
}

/** Samples the exact owner and waiter connection state without ordering the race by elapsed time. */
async function observeBlockedStatement(
  ownerPid: number,
  peerPid: number,
  settled: () => boolean,
): Promise<string> {
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    if (settled()) return "settled";
    const result = await pool.query<{ query: string }>(`
      SELECT query FROM pg_stat_activity WHERE pid = $1 AND $2 = ANY (pg_blocking_pids(pid))
    `, [peerPid, ownerPid]);
    if (result.rows[0] !== undefined) return result.rows[0].query;
    await pause(5);
  }
  throw new Error("The competing throttling transaction neither settled nor waited for the owner.");
}

function createAdapter(
  options: ConstructorParameters<typeof PostgresRateLimitAdapter>[1] = {},
  connection = database,
): PostgresRateLimitAdapter {
  return new PostgresRateLimitAdapter(
    connection,
    { maxConcurrentReservations: 1, ...options },
    testRateLimits as unknown as typeof throttlingRateLimits,
    testRateLimitLeases as unknown as typeof throttlingRateLimitLeases,
  );
}
