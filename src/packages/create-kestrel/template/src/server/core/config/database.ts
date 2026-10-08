// Defines PostgreSQL connection settings, TLS defaults, and environment-variable mappings.
// Configure DB_* values for deployments; tests select the separate DB_TEST_DATABASE.

import { postgresDrizzleConfigBase } from "@kestreljs/framework/db/configuration";
import { configure } from "@kestreljs/framework/configuration";
import type { AppConfigurationApi } from "../app_config.js";

/** Local defaults are explicit; deployed environments require their own credentials. */
export function createDatabaseConfig({
  envs,
  envVar,
  fromEnv,
}: AppConfigurationApi) {
  return configure(postgresDrizzleConfigBase, {
    host: fromEnv({
      ...envs(["local", "test"], envVar("DB_HOST", {
        fallback: "127.0.0.1",
      })),
      default: envVar("DB_HOST"),
    }),
    port: fromEnv({
      ...envs(["local", "test"], envVar("DB_PORT", {
        fallback: 55432,
      })),
      default: envVar("DB_PORT"),
    }),
    user: fromEnv({
      ...envs(["local", "test"], envVar("DB_USER", {
        fallback: "postgres",
      })),
      default: envVar("DB_USER"),
    }),
    password: fromEnv({
      ...envs(["local", "test"], envVar("DB_PASSWORD", {
        fallback: "postgres",
      })),
      default: envVar("DB_PASSWORD"),
    }),
    database: fromEnv({
      local: envVar("DB_DATABASE", {
        fallback: "__KESTREL_DATABASE_NAME__",
      }),
      test: envVar("DB_TEST_DATABASE", {
        fallback: "__KESTREL_TEST_DATABASE_NAME__",
      }),
      default: envVar("DB_DATABASE"),
    }),
    ssl: fromEnv({
      ...envs(["local", "test"], envVar("DB_SSL", {
        fallback: false,
      })),
      default: envVar("DB_SSL", {
        fallback: true,
      }),
    }),
  });
}
