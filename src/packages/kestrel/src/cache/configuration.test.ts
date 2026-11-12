import { expect, it } from "vitest";

import { memoryCacheConfigBase } from "./adapters/memory/configuration.js";
import { postgresCacheConfigBase } from "./adapters/postgres/configuration.js";
import { cacheConfigBase } from "./configuration.js";

it("coerces textual limits without weakening the shared cache policy", () => {
  expect(cacheConfigBase.schema.parse({
    namespace: "accounts",
    lockKeyPrefix: "shared-fill",
    defaultTtlSeconds: "20",
    maxTtlSeconds: 180,
    maxEntrySizeBytes: "512",
    pruneBatchSize: "5",
    pruneIntervalSeconds: "0",
  })).toEqual({
    namespace: "accounts", lockKeyPrefix: "shared-fill",
    defaultTtlSeconds: 20, maxTtlSeconds: 180, maxEntrySizeBytes: 512,
    pruneBatchSize: 5, pruneIntervalSeconds: 0,
  });
  // Configuration text may be coerced, but an empty prefix is never usable.
  expect(() => cacheConfigBase.schema.parse({ namespace: "accounts", lockKeyPrefix: "" })).toThrow();
  expect(cacheConfigBase.schema.parse({ namespace: "accounts" }).lockKeyPrefix).toBe("cache-fill");
});

it("coerces independent adapter limits from configuration text", () => {
  expect(memoryCacheConfigBase.schema.parse({ maxEntries: "10", maxSizeBytes: "1024" }))
    .toEqual({ maxEntries: 10, maxSizeBytes: 1_024 });
  expect(postgresCacheConfigBase.schema.parse({ maxEntries: "20" }))
    .toEqual({ maxEntries: 20 });
});
