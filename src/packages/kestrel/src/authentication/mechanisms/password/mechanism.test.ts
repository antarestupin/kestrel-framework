import { describe, expect, it } from "vitest";

import { MemoryAuthenticationAdapter } from "../../adapters/memory/index.js";
import type { AuthenticationConfig } from "../../configuration.js";
import { PasswordMechanism } from "./mechanism.js";
import { DefaultUsernameNormalizer } from "./normalization.js";
import type { PasswordHasher } from "./types.js";

const config: AuthenticationConfig = {
  session: {
    tokenBytes: 32,
    idleTtlSeconds: 60,
    absoluteTtlSeconds: 300,
    touchIntervalSeconds: 10,
    maxClaimsBytes: 1_024,
  },
  mechanisms: { password: { minLength: 12, maxLength: 100 } },
  http: {
    cookie: {
      name: "session",
      secure: false,
      sameSite: "lax",
      path: "/",
    },
    trustedOrigins: ["http://localhost"],
  },
};

describe("PasswordMechanism", () => {
  it("normalizes usernames, verifies credentials, and upgrades hashes", async () => {
    const adapter = new MemoryAuthenticationAdapter({
      createId: createSequentialId(),
    });
    const account = await adapter.createAccount({ subjectId: "subject-1" });
    await adapter.createPasswordCredential({
      accountId: account.id,
      username: "TestUser",
      normalizedUsername: "testuser",
      passwordHash: "old:correct-password",
    });
    const hasher = new FakePasswordHasher();
    const mechanism = new PasswordMechanism({
      credentialStore: adapter,
      passwordHasher: hasher,
      usernameNormalizer: new DefaultUsernameNormalizer(),
    }, config, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await mechanism.authenticate({
      username: "  ＴｅｓｔＵｓｅｒ  ",
      password: "correct-password",
    });

    expect(result.status).toBe("verified");
    expect(hasher.verifiedHashes).toEqual(["old:correct-password"]);
    expect(
      (await adapter.findByNormalizedUsername("testuser"))?.passwordHash,
    ).toBe("new:correct-password");
  });

  it("uses the dummy hash for unknown usernames and oversized inputs", async () => {
    const adapter = new MemoryAuthenticationAdapter();
    const hasher = new FakePasswordHasher();
    const mechanism = new PasswordMechanism({
      credentialStore: adapter,
      passwordHasher: hasher,
      usernameNormalizer: new DefaultUsernameNormalizer(),
    }, config);

    await expect(mechanism.authenticate({
      username: "missing",
      password: "incorrect-password",
    })).resolves.toEqual({ status: "rejected" });
    await expect(mechanism.authenticate({
      username: "missing",
      password: "x".repeat(101),
    })).resolves.toEqual({ status: "rejected" });

    expect(hasher.verifiedHashes).toEqual(["dummy", "dummy"]);
  });

  it("verifies stored passwords shorter than the current creation policy", async () => {
    const adapter = new MemoryAuthenticationAdapter();
    const account = await adapter.createAccount({ subjectId: "subject-1" });
    await adapter.createPasswordCredential({
      accountId: account.id,
      username: "admin",
      normalizedUsername: "admin",
      passwordHash: "old:admin",
    });
    const mechanism = new PasswordMechanism({
      credentialStore: adapter,
      passwordHasher: new FakePasswordHasher(),
      usernameNormalizer: new DefaultUsernameNormalizer(),
    }, config);

    await expect(mechanism.authenticate({
      username: "admin",
      password: "admin",
    })).resolves.toMatchObject({ status: "verified" });
  });
});

class FakePasswordHasher implements PasswordHasher {
  public readonly id = "fake";

  public readonly verifiedHashes: string[] = [];

  public async hash(password: string): Promise<string> {
    return `new:${password}`;
  }

  public async verify(password: string, encodedHash: string): Promise<boolean> {
    this.verifiedHashes.push(encodedHash);
    return encodedHash === `old:${password}` || encodedHash === `new:${password}`;
  }

  public needsRehash(encodedHash: string): boolean {
    return encodedHash.startsWith("old:");
  }

  public async getDummyHash(): Promise<string> {
    return "dummy";
  }
}

function createSequentialId(): () => string {
  let nextId = 0;
  return () => `id-${++nextId}`;
}
