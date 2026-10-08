import { expect, it } from "vitest";
import { configure, createConfigurationApi } from "../../../configuration/index.js";
import { cacheConfigBase } from "../../configuration.js";
import { redisCacheConfigBase } from "./configuration.js";
import { postgresCacheConfigBase } from "../postgres/configuration.js";

it("resolves nested adapter settings and conventional environment overrides independently", () => {
  const configuration = createConfigurationApi({
    environments: ["test"], defaultEnvironment: "test", environmentOverrides: { prefix: "APP_CONFIG" },
  });
  const definition = { cache: configure(cacheConfigBase, {
    namespace: "test", adapter: configure(redisCacheConfigBase, {}),
  }) };
  const resolved = configuration.resolveConfig(definition, { env: {
    APP_CONFIG__CACHE__ADAPTER__KEY_PREFIX: "custom:",
  } });
  expect(resolved.cache.adapter.keyPrefix).toBe("custom:");
  expect(resolved.cache.defaultTtlSeconds).toBe(3600);
  expect("maxEntries" in resolved.cache).toBe(false);
  expect(() => configuration.resolveConfig(definition, { env: {
    APP_CONFIG__CACHE__ADAPTER__KEY_PREFIX: "",
  } })).toThrow();
  expect(() => postgresCacheConfigBase.schema.parse({ maxEntries: 0 })).toThrow();
});

it("retains resolved settings until the borrowed connection is used to construct storage", async () => {
  const { createDependencyContainer, dep, registerAdapter } = await import("../../../di/index.js");
  const { redisCache } = await import("./definition.js");
  const { vi } = await import("vitest");
  const sendCommand = vi.fn(async (_arguments: string[]) => null);
  const connection = dep<{ sendCommand: typeof sendCommand }>("cacheRedis");
  let reads = 0;
  const settings = Object.freeze({
    // Reading configuration must be deferred with construction, not triggered by a copy or revalidation.
    get keyPrefix() { reads++; return "selected:"; },
  });
  const definition = redisCache(connection, settings);
  expect(reads).toBe(0);
  const container = createDependencyContainer({});
  try {
    container.registerValue(connection.id, { sendCommand });
    const registration = registerAdapter(container, "cacheAdapter", definition,
      cacheConfigBase.schema.parse({ namespace: "test" }));
    await registration.get().get("key");
    expect(reads).toBe(1);
    expect(sendCommand).toHaveBeenCalledWith(["GET", "selected:key"]);
  } finally { await container.dispose(); }
});
