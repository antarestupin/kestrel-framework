import type { RedisClientType } from "@redis/client";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import { defineTokenStorageAdapter } from "../../adapter_definition.js";
import { RedisTokenStorageAdapter } from "./adapter.js";
import { redisTokensConfigBase, type RedisTokensConfig } from "./configuration.js";

/** Constructs synchronously in the execution scope and borrows a shared Redis client. */
export function redisTokens(
  connection: RegisteredDependencyDescriptor<Pick<RedisClientType, "eval">>,
  settings: RedisTokensConfig = redisTokensConfigBase.schema.parse({}),
) {
  return defineTokenStorageAdapter({
    dependencies: { connection }, capabilities: {},
    create: ({ connection }) => new RedisTokenStorageAdapter(connection, settings),
  });
}
