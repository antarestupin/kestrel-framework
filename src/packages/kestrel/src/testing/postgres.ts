import { Pool } from "pg";

import { postgresDrizzleConfigBase } from "../db/index.js";

/**
 * Resolves PostgreSQL settings for Kestrel integration tests without depending
 * on the application bootstrap or its deployment configuration.
 */
export function createPostgresTestConfig() {
  // The Kestrel schema keeps parsing and validation aligned with the
  // PostgreSQL library while a dedicated database isolates Kestrel tests.
  return postgresDrizzleConfigBase.schema.parse({
    host: process.env.DB_HOST ?? "localhost",
    port: process.env.DB_PORT ?? process.env.KESTREL_POSTGRES_PORT ?? 55432,
    user: process.env.DB_USER ?? "postgres",
    password: process.env.DB_PASSWORD ?? "postgres",
    database: process.env.KESTREL_TEST_DATABASE ?? "kestrel_test",
    ssl: process.env.DB_SSL ?? false,
  });
}

/** Creates an independently owned pool using the shared test connection settings. */
export function createPostgresTestPool(): Pool {
  return new Pool(createPostgresTestConfig());
}
