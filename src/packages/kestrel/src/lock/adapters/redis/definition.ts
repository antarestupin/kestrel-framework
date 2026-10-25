import type { RedisClientType } from "@redis/client";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import { defineLockAdapter } from "../../adapter_definition.js";
import { RedisLockAdapter } from "./adapter.js";
import { redisLocksConfigBase, type RedisLocksConfig } from "./configuration.js";

/** Borrows the shared connection; native lease expiration needs no pruning task. */
export function redisLocks(
  connection: RegisteredDependencyDescriptor<Pick<RedisClientType, "eval">>,
  settings: RedisLocksConfig = redisLocksConfigBase.schema.parse({}),
) {
  return defineLockAdapter({
    dependencies: { connection }, capabilities: { prune: false },
    create: ({ connection }) => new RedisLockAdapter(connection, settings),
  });
}
