import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it, vi } from "vitest";

it("exports the durable bucket and lease schemas used by migrations", async () => {
  // A mutated declaration can fail before exports exist, so load it within the test.
  vi.resetModules();
  const { getFrameworkDatabaseTableKeys } = await import("../db/framework_table.js");
  const { getDatabaseSchemaContributions } = await import("../db/schema_contributions/index.js");
  const { throttlingRateLimitLeases, throttlingRateLimits } = await import("./postgres_schema.js");
  const buckets = getTableConfig(throttlingRateLimits);
  const leases = getTableConfig(throttlingRateLimitLeases);
  expect([buckets.schema, buckets.name, leases.schema, leases.name]).toEqual([
    "utils", "throttling_rate_limit", "utils", "throttling_rate_limit_lease",
  ]);
  expect(buckets.columns.map((column) => [column.name, column.getSQLType(), column.notNull])).toEqual([
    ["key", "text", true],
    ["limit", "double precision", true],
    ["period_ms", "double precision", true],
    ["burst", "double precision", true],
    ["coordination_strategy", "text", true],
    ["max_lease_units", "double precision", false],
    ["lease_ms", "double precision", false],
    ["max_outstanding_units", "double precision", false],
    ["guard_band_units", "double precision", false],
    ["tokens", "double precision", true],
    ["refilled_at", "timestamp with time zone", true],
    ["full_at", "timestamp with time zone", true],
    ["last_admitted", "boolean", true],
  ]);
  expect(leases.columns.map((column) => [column.name, column.getSQLType(), column.notNull])).toEqual([
    ["id", "text", true],
    ["rate_limit_key", "text", true],
    ["owner_id", "text", true],
    ["units", "double precision", true],
    ["expires_at", "timestamp with time zone", true],
    ["returned_at", "timestamp with time zone", false],
    ["returned_units", "double precision", true],
    ["created_at", "timestamp with time zone", true],
  ]);
  expect(throttlingRateLimits.key.primary).toBe(true);
  expect(throttlingRateLimits.coordinationStrategy.default).toBe("exact");
  expect(throttlingRateLimitLeases.id.primary).toBe(true);
  expect(throttlingRateLimitLeases.returnedUnits.default).toBe(0);
  expect([
    throttlingRateLimits.refilledAt, throttlingRateLimits.fullAt,
    throttlingRateLimitLeases.expiresAt, throttlingRateLimitLeases.returnedAt, throttlingRateLimitLeases.createdAt,
  ].map((column) => column.dataType)).toEqual(Array(5).fill("date"));
  expect(buckets.indexes.map(({ config }) => config)).toMatchObject([
    { name: "throttling_rate_limit_full_at_idx", columns: [{ name: "full_at" }] },
  ]);
  expect(leases.indexes.map(({ config }) => config)).toMatchObject([
    { name: "throttling_rate_limit_lease_key_expires_at_idx", columns: [{ name: "rate_limit_key" }, { name: "expires_at" }] },
    { name: "throttling_rate_limit_lease_expires_at_idx", columns: [{ name: "expires_at" }] },
  ]);

  // Framework ownership controls schema-push filters, and descriptions ship with migrations.
  const tables = { throttlingRateLimitLeases, throttlingRateLimits };
  expect(getFrameworkDatabaseTableKeys(tables)).toEqual(new Set([
    '["utils","throttling_rate_limit"]', '["utils","throttling_rate_limit_lease"]',
  ]));
  const contributions = getDatabaseSchemaContributions(tables);
  for (const { name, columns } of [buckets, leases]) {
    const descriptions = contributions.find((entry) => entry.id === `postgres.table:utils.${name}:descriptions`);
    expect(descriptions?.installSql).toContain(`COMMENT ON TABLE "utils"."${name}"`);
    for (const column of columns) {
      expect(descriptions?.installSql).toContain(`COMMENT ON COLUMN "utils"."${name}"."${column.name}"`);
    }
  }
});
