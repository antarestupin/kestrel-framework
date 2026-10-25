import type { RedisClientType } from "@redis/client";
import type { RegisteredDependencyDescriptor } from "../../../di/index.js";
import { defineSessionStorageAdapter } from "../../adapter_definition.js";
import { RedisSessionStorageAdapter } from "./adapter.js";
import { redisSessionsConfigBase, type RedisSessionsConfig } from "./configuration.js";

/** The shared client is ready before execution-local adapters are resolved. */
export function redisSessions<Claims = unknown>(
  connection: RegisteredDependencyDescriptor<Pick<RedisClientType, "eval">>,
  settings: RedisSessionsConfig = redisSessionsConfigBase.schema.parse({}),
) {
  return defineSessionStorageAdapter({
    dependencies: { connection }, capabilities: {},
    create: ({ connection }) => new RedisSessionStorageAdapter<Claims>(connection, settings),
  });
}
