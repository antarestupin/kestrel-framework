import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../../app/index.js";
import { dep } from "../../di/index.js";
import {
  MemoryRateLimitAdapter,
  ThrottlingManager,
} from "../../throttling/index.js";
import type { AuthenticationAttemptGuard } from "../attempt_guard.js";
import { AuthenticationRateLimitedError } from "../errors.js";
import { DefaultUsernameNormalizer } from "../mechanisms/password/index.js";
import { AuthenticationThrottlingGuard, AuthenticationThrottlingProvider } from "./throttling.js";

const managers = new Set<ThrottlingManager>();

afterEach(async () => {
  await Promise.all([...managers].map((manager) => manager.close()));
  managers.clear();
});

function createThrottlingManager(): ThrottlingManager {
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  const manager = new ThrottlingManager(new MemoryRateLimitAdapter({ now }), { namespace: "test", now });
  managers.add(manager);
  return manager;
}

describe("AuthenticationThrottlingGuard", () => {
  it("applies independent username and IP partitions", async () => {
    const guard = new AuthenticationThrottlingGuard({
      throttling: createThrottlingManager(),
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

    // A fresh username on a fresh IP must stay eligible after the first IP fills up.
    await expect(guard.run({
      credentials: { username: "Fourth", password: "password" },
      metadata: { ipAddress: "192.0.2.2" },
    }, async () => "other IP")).resolves.toBe("other IP");
  });

  it("applies the default username quota without an IP and preserves operation errors", async () => {
    const guard = new AuthenticationThrottlingGuard({
      throttling: createThrottlingManager(),
      usernameNormalizer: new DefaultUsernameNormalizer(),
    }, { keySecret: new Uint8Array(32).fill(1) });
    const input = { credentials: { username: "User", password: "password" } };
    const operationError = new Error("Credential store unavailable");

    await expect(guard.run(input, async () => { throw operationError; })).rejects.toBe(operationError);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(guard.run(input, async () => "allowed")).resolves.toBe("allowed");
    }

    // A failed authentication operation still consumes its admission, and missing IP does not bypass the username limit.
    const blockedOperation = vi.fn(async () => "unexpected");
    await expect(guard.run(input, blockedOperation)).rejects.toBeInstanceOf(AuthenticationRateLimitedError);
    expect(blockedOperation).not.toHaveBeenCalled();
  });

  it("validates key length in bytes for text and binary secrets", () => {
    const dependencies = {
      throttling: createThrottlingManager(),
      usernameNormalizer: new DefaultUsernameNormalizer(),
    };
    expect(() => new AuthenticationThrottlingGuard(dependencies, { keySecret: "a".repeat(31) }))
      .toThrow("Authentication throttling key secrets must contain at least 32 bytes.");
    expect(() => new AuthenticationThrottlingGuard(dependencies, { keySecret: new Uint8Array(31) }))
      .toThrow("Authentication throttling key secrets must contain at least 32 bytes.");
    expect(() => new AuthenticationThrottlingGuard(dependencies, { keySecret: "é".repeat(16) }))
      .not.toThrow();
  });

  it("composes scoped guards that share the configured burst across executions", async () => {
    const app = new App({});
    const guardDependency = dep<AuthenticationAttemptGuard>("authenticationAttemptGuard");
    app.container.registerValue("throttling", createThrottlingManager());
    app.container.registerValue("usernameNormalizer", new DefaultUsernameNormalizer());
    app.register(new AuthenticationThrottlingProvider({
      keySecret: "a-secure-test-secret-containing-32-bytes",
      username: { requests: 1, perSeconds: 60, burst: 2 },
    }));
    const first = app.container.createScope();
    const second = app.container.createScope();
    try {
      const firstGuard = first.resolve(guardDependency);
      const secondGuard = second.resolve(guardDependency);
      const input = { credentials: { username: "User", password: "password" } };

      // A fresh scope receives its own guard but cannot reset the shared rate-limit budget.
      expect(firstGuard).toBe(first.resolve(guardDependency));
      expect(firstGuard === secondGuard).toBe(false);
      await expect(firstGuard.run(input, async () => "first")).resolves.toBe("first");
      await expect(secondGuard.run(input, async () => "second")).resolves.toBe("second");
      await expect(secondGuard.run(input, async () => "unexpected")).rejects.toBeInstanceOf(AuthenticationRateLimitedError);
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
      await app.dispose();
    }
  });
});

