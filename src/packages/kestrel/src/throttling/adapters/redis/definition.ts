import type { RedisClientType } from "@redis/client";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import { defineThrottlingAdapter } from "../../adapter_definition.js";
import { BackendFailureRateLimitAdapter } from "../backend_failure/adapter.js";
import { DenialCachingRateLimitAdapter } from "../denial_caching/adapter.js";
import { LeasedRateLimitAdapter } from "../leased/adapter.js";
import { RedisRateLimitAdapter } from "./adapter.js";
import { redisThrottlingConfigBase, type RedisThrottlingConfig } from "./configuration.js";

/** Uses the same policy decorators as PostgreSQL, without a pruning capability. */
export function redisThrottling(
  connection: RegisteredDependencyDescriptor<Pick<RedisClientType, "eval">>,
  settings: RedisThrottlingConfig = redisThrottlingConfigBase.schema.parse({}),
) {
  return defineThrottlingAdapter({
    dependencies: { connection }, capabilities: { prune: false },
    create: ({ connection }, { config, instrumentation }) => new LeasedRateLimitAdapter(
      new BackendFailureRateLimitAdapter(
        new DenialCachingRateLimitAdapter(new RedisRateLimitAdapter(connection, settings)), config.backendFailurePolicy,
      ), instrumentation === undefined ? {} : { instrumentation },
    ),
    dispose: (adapter) => adapter.close(),
  });
}
