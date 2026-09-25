import { describe, expect, it } from "vitest";

import { MemoryRateLimitAdapter } from "./adapter.js";

describe("MemoryRateLimitAdapter", () => {
  it("refills a token bucket continuously", async () => {
    let nowMs = 0;
    const adapter = new MemoryRateLimitAdapter({
      now: () => new Date(nowMs),
    });
    const request = {
      key: "app:api",
      limit: 2,
      periodMs: 1_000,
      burst: 2,
      cost: 1,
    };

    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: true,
      remaining: 1,
    });
    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: true,
      remaining: 0,
    });
    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: false,
      remaining: 0,
      retryAt: new Date(500),
    });

    nowMs = 500;

    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: true,
      remaining: 0,
    });
  });

  it("supports weighted reservations and caps refill at burst capacity", async () => {
    let nowMs = 0;
    const adapter = new MemoryRateLimitAdapter({
      now: () => new Date(nowMs),
    });
    const request = {
      key: "app:weighted",
      limit: 10,
      periodMs: 1_000,
      burst: 5,
      cost: 3,
    };

    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: true,
      remaining: 2,
    });

    nowMs = 10_000;

    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: true,
      remaining: 2,
    });
  });

  it("keeps buckets independent and does not mint tokens when time moves back", async () => {
    let nowMs = 1_000;
    const adapter = new MemoryRateLimitAdapter({
      now: () => new Date(nowMs),
    });
    const request = {
      key: "app:first",
      limit: 1,
      periodMs: 1_000,
      burst: 1,
      cost: 1,
    };

    await expect(adapter.reserve(request)).resolves.toMatchObject({
      admitted: true,
    });
    await expect(adapter.reserve({ ...request, key: "app:second" }))
      .resolves.toMatchObject({ admitted: true });

    nowMs = 500;

    await expect(adapter.reserve(request)).resolves.toEqual({
      admitted: false,
      remaining: 0,
      retryAt: new Date(2_000),
    });
  });

  it("rejects malformed adapter requests", async () => {
    const adapter = new MemoryRateLimitAdapter();

    await expect(adapter.reserve({
      key: "",
      limit: 1,
      periodMs: 1_000,
      burst: 1,
      cost: 1,
    })).rejects.toThrow(TypeError);

    await expect(adapter.reserve({
      key: "app:api",
      limit: 1,
      periodMs: 1_000,
      burst: 1,
      cost: 2,
    })).rejects.toThrow("cost cannot exceed burst");
  });
});
