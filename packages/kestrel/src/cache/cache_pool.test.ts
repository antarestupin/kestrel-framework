import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { CachePool, TagAwareCachePool, isTagAwareAdapter } from "./cache_pool.js";
import { CacheLockUnavailableError } from "./errors.js";
import {
  cacheAccessObservation,
  cacheInvalidationObservation,
  cacheLoadObservation,
  cacheWriteObservation,
  type CacheInstrumentationEvent,
} from "./observations.js";
import {
  LockManager,
  MemoryLockAdapter,
  type Awaitable,
  type LockHandle,
  type LockRunContext,
  type LockRunOptions,
  type Locks,
} from "../lock/index.js";
import type {
  CacheAdapter,
  CacheEntry,
  CacheStorageError,
  TagAwareCacheAdapter,
} from "./types.js";

class TestAdapter implements CacheAdapter {
  public readonly entries = new Map<string, CacheEntry>();

  public getError?: Error;

  public setError?: Error;

  public async get(
    key: string,
  ): Promise<CacheEntry | undefined> {
    if (this.getError !== undefined) {
      throw this.getError;
    }

    return this.entries.get(key);
  }

  public async set(
    key: string,
    entry: CacheEntry,
  ): Promise<void> {
    if (this.setError !== undefined) {
      throw this.setError;
    }

    this.entries.set(key, entry);
  }

  public async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }
}

class TaggedTestAdapter extends TestAdapter
  implements TagAwareCacheAdapter
{
  public async invalidateAllTags(
    tags: readonly string[],
  ): Promise<number> {
    let removed = 0;

    for (const [key, entry] of this.entries) {
      if (tags.every((tag) => entry.tags.includes(tag))) {
        this.entries.delete(key);
        removed += 1;
      }
    }

    return removed;
  }
}

function createPool(
  adapter: TagAwareCacheAdapter,
  overrides?: Partial<ConstructorParameters<typeof CachePool>[1]>,
  locks?: Pick<Locks, "runExclusive">,
): TagAwareCachePool;
function createPool(
  adapter: CacheAdapter,
  overrides?: Partial<ConstructorParameters<typeof CachePool>[1]>,
  locks?: Pick<Locks, "runExclusive">,
): CachePool;
function createPool(
  adapter: CacheAdapter,
  overrides: Partial<ConstructorParameters<typeof CachePool>[1]> = {},
  locks?: Pick<Locks, "runExclusive">,
): CachePool {
  const options = {
    namespace: "test",
    defaultTtlSeconds: 60,
    maxTtlSeconds: 3_600,
    maxEntrySizeBytes: 1_024,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
  return isTagAwareAdapter(adapter)
    ? new TagAwareCachePool(adapter, options, locks)
    : new CachePool(adapter, options, locks);
}

describe("CachePool", () => {
  it("exports stable typed observation definitions", () => {
    expect(cacheAccessObservation).toMatchObject({
      name: "cache.access",
      category: "cache",
      schemaVersion: 1,
    });
    expect(cacheLoadObservation.name).toBe("cache.load");
    expect(cacheWriteObservation.name).toBe("cache.write");
    expect(cacheInvalidationObservation.name).toBe(
      "cache.invalidation",
    );
  });

  it("distinguishes a cached null value from a miss", async () => {
    const adapter = new TestAdapter();
    const cache = createPool(adapter);

    await cache.set("nullable", null);

    await expect(cache.get("nullable")).resolves.toBeNull();
    await expect(cache.get("missing")).resolves.toBeUndefined();
  });

  it("serializes values before handing them to an adapter", async () => {
    const adapter = new TestAdapter();
    const cache = createPool(adapter);
    const source = { nested: { value: "before" } };

    await cache.set("object", source);
    source.nested.value = "after";

    await expect(cache.get("object")).resolves.toEqual({
      nested: { value: "before" },
    });
  });

  it("uses default TTL and caps an explicit TTL", async () => {
    const adapter = new TestAdapter();
    const cache = createPool(adapter, { maxTtlSeconds: 120 });

    await cache.set("default", "value");
    await cache.set("capped", "value", { ttlSeconds: 600 });

    expect(adapter.entries.get("test:default")?.expiresAt)
      .toEqual(new Date("2026-01-01T00:01:00.000Z"));
    expect(adapter.entries.get("test:capped")?.expiresAt)
      .toEqual(new Date("2026-01-01T00:02:00.000Z"));
  });

  it("rejects invalid keys, values, TTLs and tags", async () => {
    const cache = createPool(new TaggedTestAdapter());

    await expect(cache.set("", "value")).rejects.toThrow(
      "Cache keys cannot be empty",
    );
    await expect(cache.set("key", undefined)).rejects.toThrow(
      "cannot be undefined",
    );
    await expect(cache.set("key", "value", { ttlSeconds: 0 }))
      .rejects.toThrow("positive finite");
    await expect(cache.set("key", "value", { tags: [""] }))
      .rejects.toThrow("cannot be empty");
    await expect(cache.invalidateAllTags([])).rejects.toThrow(
      "At least one",
    );
  });

  it("does not store an oversized entry", async () => {
    const adapter = new TestAdapter();
    const cache = createPool(adapter, { maxEntrySizeBytes: 5 });

    await cache.set("large", "larger than five bytes");

    expect(adapter.entries).toHaveLength(0);
  });

  it("includes keys and tags in entry size accounting", async () => {
    const adapter = new TaggedTestAdapter();
    const cache = createPool(adapter, { maxEntrySizeBytes: 20 });

    await cache.set("key", "", {
      tags: ["metadata-that-exceeds-the-limit"],
    });

    expect(adapter.entries).toHaveLength(0);
  });

  it("treats read failures as misses and reports them", async () => {
    const adapter = new TestAdapter();
    const report = vi.fn<(failure: CacheStorageError) => void>();
    adapter.getError = new Error("read failed");
    const cache = createPool(adapter, { reportStorageError: report });

    await expect(cache.get("key")).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      error: adapter.getError,
      operation: "get",
    }));
  });

  it("does not fail an explicit operation when storage writes fail", async () => {
    const adapter = new TestAdapter();
    const report = vi.fn<(failure: CacheStorageError) => void>();
    adapter.setError = new Error("write failed");
    const cache = createPool(adapter, { reportStorageError: report });

    await expect(cache.set("key", "value")).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      error: adapter.setError,
      operation: "set",
    }));
  });

  it("loads a missing value and reuses the cached result", async () => {
    const cache = createPool(new TestAdapter());
    const loader = vi.fn(async () => "loaded");

    await expect(cache.remember("key", loader)).resolves.toBe("loaded");
    await expect(cache.remember("key", loader)).resolves.toBe("loaded");
    expect(loader).toHaveBeenCalledOnce();
  });

  it("records a read-through load without capturing its value", async () => {
    const instrumentation = new RecordingCacheInstrumentation();
    let time = 0;
    const cache = createPool(new TestAdapter(), {
      instrumentation,
      formatObservationKey: (key) => `redacted:${key}`,
      monotonicNow: () => {
        time += 5;
        return time;
      },
    });

    await cache.remember("key", async () => ({ secret: "hidden" }));

    expect(instrumentation.events).toEqual([
      {
        type: "access",
        outcome: "success",
        durationMs: 5,
        data: {
          key: "redacted:test:key",
          operation: "remember",
          result: "miss",
          phase: "initial",
        },
      },
      {
        type: "load",
        outcome: "success",
        durationMs: 5,
        data: {
          key: "redacted:test:key",
          result: "loaded",
          coordination: "none",
        },
      },
      {
        type: "write",
        outcome: "success",
        durationMs: 5,
        data: {
          key: "redacted:test:key",
          operation: "remember",
          result: "stored",
          ttlSeconds: 60,
          sizeBytes: 29,
          tagCount: 0,
        },
      },
    ]);
    expect(JSON.stringify(instrumentation.events)).not.toContain("hidden");
  });

  it("records hits, misses, coalescing and fail-open storage errors", async () => {
    const adapter = new TestAdapter();
    const instrumentation = new RecordingCacheInstrumentation();
    const cache = createPool(adapter, { instrumentation });
    let resolveLoader: ((value: string) => void) | undefined;

    await cache.get("missing");
    const first = cache.remember("coalesced", () =>
      new Promise<string>((resolve) => {
        resolveLoader = resolve;
      }));
    const second = cache.remember("coalesced", async () => "unused");
    await vi.waitFor(() => expect(resolveLoader).toBeDefined());
    resolveLoader?.("loaded");
    await Promise.all([first, second]);
    await cache.get("coalesced");
    adapter.getError = new Error("read failed");
    await cache.get("error");

    const accessEvents = instrumentation.events.filter(
      (event) => event.type === "access",
    );
    expect(accessEvents.map((event) => event.data.result)).toEqual([
      "miss",
      "miss",
      "miss",
      "local-coalesced",
      "hit",
      "error",
    ]);
    expect(accessEvents.at(-1)?.outcome).toBe("failure");
  });

  it("records loader and cache-write failures independently", async () => {
    const adapter = new TestAdapter();
    const instrumentation = new RecordingCacheInstrumentation();
    const cache = createPool(adapter, { instrumentation });

    await expect(cache.remember("loader", async () => {
      throw new Error("source failed");
    })).rejects.toThrow("source failed");

    adapter.setError = new Error("write failed");
    await expect(cache.remember("write", async () => "loaded"))
      .resolves.toBe("loaded");

    expect(instrumentation.events.filter(
      (event) => event.type === "load",
    ).map((event) => ({
      outcome: event.outcome,
      result: event.data.result,
    }))).toEqual([
      { outcome: "failure", result: "error" },
      { outcome: "success", result: "loaded" },
    ]);
    expect(instrumentation.events.find(
      (event) => event.type === "write"
        && event.data.key === "test:write",
    )).toMatchObject({
      outcome: "failure",
      data: { result: "error" },
    });
  });

  it("coalesces concurrent loaders for the same key", async () => {
    const cache = createPool(new TestAdapter());
    let resolveLoader: ((value: string) => void) | undefined;
    const loader = vi.fn(() => new Promise<string>((resolve) => {
      resolveLoader = resolve;
    }));

    const first = cache.remember("key", loader);
    const second = cache.remember("key", loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    resolveLoader?.("loaded");

    await expect(Promise.all([first, second])).resolves.toEqual([
      "loaded",
      "loaded",
    ]);
  });

  it("passes a namespaced key and explicit options to the lock service", async () => {
    const locks = new RecordingLocks();
    const cache = createPool(
      new TestAdapter(),
      { lockKeyPrefix: "cache-load" },
      locks,
    );
    const lockOptions = {
      ttlMs: 20_000,
      waitTimeoutMs: 5_000,
      retryIntervalMs: 25,
    };

    await expect(cache.remember("key", async () => "loaded", {
      lock: lockOptions,
    })).resolves.toBe("loaded");

    expect(locks.calls).toEqual([{
      key: "cache-load:test:key",
      options: lockOptions,
    }]);
  });

  it("uses lock defaults when distributed loading is enabled with true", async () => {
    const locks = new RecordingLocks();
    const cache = createPool(new TestAdapter(), {}, locks);

    await cache.remember("key", async () => "loaded", { lock: true });

    expect(locks.calls).toEqual([{
      key: "cache-fill:test:key",
      options: {},
    }]);
  });

  it("fails clearly when distributed loading has no lock service", async () => {
    const loader = vi.fn(async () => "loaded");
    const cache = createPool(new TestAdapter());

    await expect(cache.remember("key", loader, { lock: true }))
      .rejects.toEqual(new CacheLockUnavailableError());
    expect(loader).not.toHaveBeenCalled();
  });

  it("propagates lock failures without running the loader", async () => {
    const locks = new RecordingLocks();
    const failure = new Error("lock unavailable");
    const loader = vi.fn(async () => "loaded");
    locks.error = failure;
    const cache = createPool(new TestAdapter(), {}, locks);

    await expect(cache.remember("key", loader, { lock: true }))
      .rejects.toBe(failure);
    expect(loader).not.toHaveBeenCalled();
  });

  it("loads once across pools and reads the cached result after waiting", async () => {
    const adapter = new TestAdapter();
    const locks = createLockManager();
    const firstCache = createPool(adapter, {}, locks);
    const secondCache = createPool(adapter, {}, locks);
    let resolveFirst: ((value: string) => void) | undefined;
    const firstLoader = vi.fn(() => new Promise<string>((resolve) => {
      resolveFirst = resolve;
    }));
    const secondLoader = vi.fn(async () => "second");

    const first = firstCache.remember("key", firstLoader, { lock: true });
    await vi.waitFor(() => expect(firstLoader).toHaveBeenCalledOnce());
    const second = secondCache.remember("key", secondLoader, { lock: true });
    resolveFirst?.("first");

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "first",
    ]);
    expect(secondLoader).not.toHaveBeenCalled();
  });

  it("releases a distributed load after failure so another pool can retry", async () => {
    const adapter = new TestAdapter();
    const locks = createLockManager();
    const firstCache = createPool(adapter, {}, locks);
    const secondCache = createPool(adapter, {}, locks);

    await expect(firstCache.remember("key", async () => {
      throw new Error("source failed");
    }, { lock: true })).rejects.toThrow("source failed");
    await expect(secondCache.remember(
      "key",
      async () => "recovered",
      { lock: true },
    )).resolves.toBe("recovered");
  });

  it("keeps cache writes fail-open during a distributed load", async () => {
    const adapter = new TestAdapter();
    const locks = new RecordingLocks();
    const report = vi.fn<(failure: CacheStorageError) => void>();
    adapter.setError = new Error("write failed");
    const cache = createPool(
      adapter,
      { reportStorageError: report },
      locks,
    );

    await expect(cache.remember("key", async () => "loaded", {
      lock: true,
    })).resolves.toBe("loaded");
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      error: adapter.setError,
      operation: "set",
    }));
  });

  it("removes a failed in-flight loader so a later call can retry", async () => {
    const cache = createPool(new TestAdapter());
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error("source failed"))
      .mockResolvedValueOnce("recovered");

    await expect(cache.remember("key", loader)).rejects.toThrow(
      "source failed",
    );
    await expect(cache.remember("key", loader)).resolves.toBe(
      "recovered",
    );
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("returns a loaded value even when it cannot be serialized", async () => {
    const report = vi.fn<(failure: CacheStorageError) => void>();
    const cache = createPool(new TestAdapter(), {
      reportStorageError: report,
    });

    await expect(cache.remember("key", async () => 1n))
      .resolves.toBe(1n);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      operation: "set",
    }));
  });

  it("invalidates matching tags inside the pool namespace", async () => {
    const adapter = new TaggedTestAdapter();
    const cache = createPool(adapter);

    await cache.set("matching", "value", { tags: ["a", "b"] });
    await cache.set("partial", "value", { tags: ["a"] });

    await expect(cache.invalidateAllTags(["a", "b"]))
      .resolves.toBe(1);
    await expect(cache.get("matching")).resolves.toBeUndefined();
    await expect(cache.get("partial")).resolves.toBe("value");
  });

  it("records key and tag invalidation results", async () => {
    const adapter = new TaggedTestAdapter();
    const instrumentation = new RecordingCacheInstrumentation();
    const cache = createPool(adapter, { instrumentation });

    await cache.set("key", "value", { tags: ["a", "b"] });
    instrumentation.events.length = 0;
    await cache.delete("missing");
    await cache.invalidateAllTags(["a", "b"]);

    expect(instrumentation.events).toMatchObject([
      {
        type: "invalidation",
        outcome: "success",
        data: {
          operation: "delete",
          result: "not-found",
          key: "test:missing",
          affectedEntries: 0,
        },
      },
      {
        type: "invalidation",
        outcome: "success",
        data: {
          operation: "invalidate-all-tags",
          result: "completed",
          tagCount: 2,
          affectedEntries: 1,
        },
      },
    ]);
  });

  it("ignores instrumentation, formatting and clock failures", async () => {
    const adapter = new TestAdapter();
    const instrumentation = {
      record: vi.fn(() => {
        throw new Error("instrumentation failed");
      }),
    };
    const cache = createPool(adapter, { instrumentation });

    await expect(cache.set("key", "value")).resolves.toBeUndefined();
    await expect(cache.get("key")).resolves.toBe("value");
    expect(instrumentation.record).toHaveBeenCalledTimes(2);

    const formattingInstrumentation = new RecordingCacheInstrumentation();
    const formattingFailure = createPool(adapter, {
      instrumentation: formattingInstrumentation,
      formatObservationKey: () => {
        throw new Error("formatting failed");
      },
    });
    await expect(formattingFailure.get("key")).resolves.toBe("value");
    expect(formattingInstrumentation.events).toHaveLength(0);

    const clockInstrumentation = new RecordingCacheInstrumentation();
    const clockFailure = createPool(adapter, {
      instrumentation: clockInstrumentation,
      monotonicNow: () => {
        throw new Error("clock failed");
      },
    });
    await expect(clockFailure.get("key")).resolves.toBe("value");
    expect(clockInstrumentation.events[0]?.durationMs).toSatisfy(
      Number.isFinite,
    );
  });

  it("isolates composed tags between pools sharing an adapter", async () => {
    const adapter = new TaggedTestAdapter();
    const first = createPool(adapter, { namespace: "first" });
    const second = createPool(adapter, { namespace: "second" });
    await first.set("key", "first", { tags: ["shared"] });
    await second.set("key", "second", { tags: ["shared"] });

    await expect(first.invalidateAllTags(["shared"]))
      .resolves.toBe(1);
    await expect(first.get("key")).resolves.toBeUndefined();
    await expect(second.get("key")).resolves.toBe("second");
  });

  it("fails clearly when tag invalidation is unsupported", async () => {
    const cache = createPool(new TestAdapter());

    expect("invalidateAllTags" in cache).toBe(false);
    // Untyped consumers still receive an explicit error before accessing storage.
    // @ts-expect-error Basic cache options reject tags, including empty arrays.
    await expect(cache.set("key", "value", { tags: [] })).rejects.toThrow("TagAwareCache");
    const loader = vi.fn(async () => "loaded");
    // @ts-expect-error Read-through options also require tag support.
    await expect(cache.remember("key", loader, { tags: ["tag"] }))
      .rejects.toThrow("TagAwareCache");
    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects invalid lock key prefixes", () => {
    expect(() => createPool(new TestAdapter(), { lockKeyPrefix: "" }))
      .toThrow("Cache lock key prefixes cannot be empty");
    expect(() => createPool(new TestAdapter(), {
      lockKeyPrefix: "cache:fill",
    })).toThrow("Cache lock key prefixes cannot contain a colon");
  });
});

/** Captures storage-neutral events without requiring an Observer instance. */
class RecordingCacheInstrumentation {
  public readonly events: CacheInstrumentationEvent[] = [];

  public record(event: CacheInstrumentationEvent): void {
    this.events.push(event);
  }
}

/** Minimal recording implementation used to inspect cache coordination. */
class RecordingLocks implements Pick<Locks, "runExclusive"> {
  public readonly calls: Array<{
    key: string;
    options: LockRunOptions;
  }> = [];

  public error?: Error;

  public async runExclusive<Value>(
    key: string,
    handler: (
      lock: LockHandle,
      context: LockRunContext,
    ) => Awaitable<Value>,
    options: LockRunOptions = {},
  ): Promise<Value> {
    this.calls.push({ key, options });

    if (this.error !== undefined) {
      throw this.error;
    }

    return handler(
      {} as LockHandle,
      { signal: new AbortController().signal },
    );
  }
}

function createLockManager(): LockManager {
  return new LockManager(new MemoryLockAdapter(), {
    namespace: "test-locks",
    defaultTtlMs: 10_000,
    maxTtlMs: 60_000,
    defaultWaitTimeoutMs: 1_000,
    retryIntervalMs: 1,
    retryJitterRatio: 0,
  });
}
