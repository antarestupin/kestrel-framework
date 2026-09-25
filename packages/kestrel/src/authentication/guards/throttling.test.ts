import { describe, expect, it } from "vitest";

import {
  MemoryRateLimitAdapter,
  ThrottlingManager,
} from "../../throttling/index.js";
import { AuthenticationRateLimitedError } from "../errors.js";
import { DefaultUsernameNormalizer } from "../mechanisms/password/index.js";
import { AuthenticationThrottlingGuard } from "./throttling.js";

describe("AuthenticationThrottlingGuard", () => {
  it("applies independent username and IP partitions", async () => {
    const guard = new AuthenticationThrottlingGuard({
      throttling: new ThrottlingManager(
        new MemoryRateLimitAdapter(),
        { namespace: "test" },
      ),
      usernameNormalizer: new DefaultUsernameNormalizer(),
    }, {
      keySecret: "a-secure-test-secret-containing-32-bytes",
      username: { requests: 1, perSeconds: 60 },
      ip: { requests: 2, perSeconds: 60 },
    });

    await expect(guard.run({
      credentials: { username: "First", password: "password" },
      metadata: { ipAddress: "192.0.2.1" },
    }, async () => "first")).resolves.toBe("first");

    // A second source cannot bypass the per-username limit.
    await expect(guard.run({
      credentials: { username: "FIRST", password: "password" },
      metadata: { ipAddress: "192.0.2.2" },
    }, async () => "unexpected")).rejects.toBeInstanceOf(
      AuthenticationRateLimitedError,
    );

    await expect(guard.run({
      credentials: { username: "Second", password: "password" },
      metadata: { ipAddress: "192.0.2.1" },
    }, async () => "second")).resolves.toBe("second");

    // New usernames cannot bypass the independent per-IP limit.
    await expect(guard.run({
      credentials: { username: "Third", password: "password" },
      metadata: { ipAddress: "192.0.2.1" },
    }, async () => "unexpected")).rejects.toBeInstanceOf(
      AuthenticationRateLimitedError,
    );
  });
});

