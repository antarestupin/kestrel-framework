import { describe, expect, it } from "vitest";

import { createRedisTestContext } from "./redis.js";

describe("Kestrel Redis test isolation", () => {
  it.each([
    "redis://127.0.0.1:6379/0",
    "redis://127.0.0.1:6379/1",
    "redis://127.0.0.1:6379",
    "https://127.0.0.1:6379/2",
  ])("rejects a URL outside the dedicated test database: %s", async (url) => {
    await expect(createRedisTestContext({ url })).rejects.toThrow("database 2");
  });

  it("cleans a failed test's prefix and preserves another test's keys", async () => {
    const observer = await createRedisTestContext();
    try {
      const failed = await createRedisTestContext();
      const ownKey = `${observer.keyPrefix}survivor`;
      const failedKey = `${failed.keyPrefix}failed`;
      try {
        await observer.client.set(ownKey, "preserved");
        await failed.client.set(failedKey, "temporary");
      } finally {
        // The fixture uses this same finally path when a test assertion fails.
        await failed.dispose();
      }
      expect(failed.client.isOpen).toBe(false);
      await expect(observer.client.get(failedKey)).resolves.toBeNull();
      await expect(observer.client.get(ownKey)).resolves.toBe("preserved");
    } finally {
      await observer.dispose();
    }
    expect(observer.client.isOpen).toBe(false);
  });
});
