// Configures the shared Redis connection URL and connection timeout.
// Set REDIS_URL for deployments; local and test environments have separate database defaults.

import { z } from "zod";
import { configure, defineConfigBase, type ConfigOutput } from "@kestreljs/framework/configuration";
import type { AppConfigurationApi } from "../app_config.js";

const redisConfigBase = defineConfigBase(z.object({
  url: z.url().refine((value) => ["redis:", "rediss:"].includes(new URL(value).protocol), "Use a redis:// or rediss:// URL."),
  connectTimeoutMs: z.coerce.number().int().positive().default(5_000),
}));
export type RedisConfig = ConfigOutput<typeof redisConfigBase>;

/** Read environment values only in application configuration, with explicit deployment settings. */
export function createRedisConfig({
  envVar,
  fromEnv,
}: AppConfigurationApi) {
  return configure(redisConfigBase, {
    url: fromEnv({
      local: envVar("REDIS_URL", {
        fallback: "redis://127.0.0.1:56379/0",
      }),
      test: envVar("REDIS_URL", {
        fallback: "redis://127.0.0.1:56379/2",
      }),
      default: envVar("REDIS_URL"),
    }),
  });
}
