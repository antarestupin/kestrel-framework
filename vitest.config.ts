import { defineConfig } from "vitest/config";

// Integration suites always run when selected; unavailable infrastructure is a failure.
const integration = [
  "packages/kestrel/src/authentication/adapters/postgres/adapter.test.ts",
  "packages/kestrel/src/authorization/adapters/postgres/adapter.test.ts",
  "packages/kestrel/src/cache/adapters/postgres/adapter.test.ts",
  "packages/kestrel/src/cache/adapters/redis/adapter.test.ts",
  "packages/kestrel/src/database/seeder/database_seeder.test.ts",
  "packages/kestrel/src/db/history/history.integration.test.ts",
  "packages/kestrel/src/db/query_instrumentation.test.ts",
  "packages/kestrel/src/db/repository.test.ts",
  "packages/kestrel/src/lock/adapters/postgres/adapter.test.ts",
  "packages/kestrel/src/scheduled_tasks/adapters/postgres/adapter.test.ts",
  "packages/kestrel/src/testing/redis.test.ts",
  "packages/kestrel/src/throttling/adapters/postgres/adapter.test.ts",
  "packages/kestrel/src/tokens/adapters/postgres/adapter.test.ts",
  "packages/kestrel/src/workers/adapters/postgres/adapter.test.ts",
  "packages/kestrel/src/workflows/adapters/postgres/adapter.test.ts"
];
export default defineConfig({ test: { projects: [
  { test: { name: "unit", include: ["packages/**/*.test.{ts,tsx}", "apps/**/*.test.{ts,tsx}"], exclude: ["**/node_modules/**", "packages/create-kestrel/template/**", ...integration] } },
  { test: { name: "integration", include: integration } },
] } });
