import { describe, expect, it } from "vitest";

import { Argon2idPasswordHasher } from "./hasher.js";

describe("Argon2idPasswordHasher", () => {
  it("round-trips self-describing hashes and detects obsolete parameters", async () => {
    const hasher = new Argon2idPasswordHasher({
      memoryKiB: 64,
      passes: 1,
      parallelism: 1,
      saltBytes: 16,
      tagBytes: 16,
      createSalt: () => Uint8Array.from({ length: 16 }, (_, index) => index),
    });
    const encodedHash = await hasher.hash("correct horse battery staple");

    expect(encodedHash).toMatch(/^\$argon2id\$v=19\$m=64,t=1,p=1\$/);
    await expect(
      hasher.verify("correct horse battery staple", encodedHash),
    ).resolves.toBe(true);
    await expect(hasher.verify("incorrect", encodedHash)).resolves.toBe(false);
    expect(hasher.needsRehash(encodedHash)).toBe(false);

    const changed = new Argon2idPasswordHasher({
      memoryKiB: 128,
      passes: 1,
      parallelism: 1,
    });
    await expect(
      changed.verify("correct horse battery staple", encodedHash),
    ).resolves.toBe(true);
    expect(changed.needsRehash(encodedHash)).toBe(true);
  });

  it("rejects stored hashes whose parameters exceed verification limits", async () => {
    const hasher = new Argon2idPasswordHasher({
      memoryKiB: 64,
      passes: 1,
      parallelism: 1,
      saltBytes: 16,
      tagBytes: 16,
      verificationLimits: {
        maxMemoryKiB: 64,
        maxPasses: 1,
        maxParallelism: 1,
        maxSaltBytes: 16,
        maxTagBytes: 16,
      },
      createSalt: () => new Uint8Array(16),
    });
    const hashWithinBudget = await hasher.hash("password");
    const hashesOutsideBudget = [
      encodeTestHash({ memoryKiB: 65 }),
      encodeTestHash({ passes: 2 }),
      encodeTestHash({ parallelism: 2 }),
      encodeTestHash({ saltBytes: 17 }),
      encodeTestHash({ tagBytes: 17 }),
    ];

    await expect(hasher.verify("password", hashWithinBudget)).resolves.toBe(true);
    for (const encodedHash of hashesOutsideBudget) {
      await expect(hasher.verify("password", encodedHash)).resolves.toBe(false);
      expect(hasher.needsRehash(encodedHash)).toBe(true);
    }
  });

  it("fails closed for malformed stored hashes", async () => {
    const hasher = new Argon2idPasswordHasher({
      memoryKiB: 64,
      passes: 1,
      parallelism: 1,
      saltBytes: 16,
      tagBytes: 16,
    });
    const malformedHashes = [
      "",
      "$argon2i$v=19$m=64,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA",
      "$argon2id$v=19$m=64,t=1,p=1$invalid+$AAAAAAAAAAAAAAAAAAAAAA",
      encodeTestHash({ saltBytes: 15 }),
      encodeTestHash({ tagBytes: 15 }),
    ];

    for (const encodedHash of malformedHashes) {
      await expect(hasher.verify("password", encodedHash)).resolves.toBe(false);
      expect(hasher.needsRehash(encodedHash)).toBe(true);
    }
  });

  it("rejects an oversized encoded hash before parsing its fields", async () => {
    const source = new Argon2idPasswordHasher({
      memoryKiB: 64,
      passes: 1,
      parallelism: 1,
      saltBytes: 16,
      tagBytes: 16,
      createSalt: () => new Uint8Array(16),
    });
    const encodedHash = await source.hash("password");
    const hasher = new Argon2idPasswordHasher({
      memoryKiB: 64,
      passes: 1,
      parallelism: 1,
      saltBytes: 16,
      tagBytes: 16,
      verificationLimits: {
        maxEncodedHashChars: encodedHash.length,
      },
    });
    // Leading zeroes keep the fields syntactically valid while exceeding the cap.
    const oversizedHash = encodedHash.replace("m=64", "m=064");

    await expect(hasher.verify("password", encodedHash)).resolves.toBe(true);
    await expect(hasher.verify("password", oversizedHash)).resolves.toBe(false);
    expect(hasher.needsRehash(oversizedHash)).toBe(true);
  });

  it("validates that generated hashes fit within verification limits", () => {
    expect(() => new Argon2idPasswordHasher({
      verificationLimits: { maxMemoryKiB: 19_455 },
    })).toThrow("memoryKiB must not exceed its verification limit.");
    expect(() => new Argon2idPasswordHasher({
      verificationLimits: { maxSaltBytes: 15 },
    })).toThrow("saltBytes must not exceed its verification limit.");
    expect(() => new Argon2idPasswordHasher({
      verificationLimits: { maxEncodedHashChars: 1 },
    })).toThrow("Argon2id hash output must fit within maxEncodedHashChars.");
    expect(() => new Argon2idPasswordHasher({
      verificationLimits: { maxPasses: 0 },
    })).toThrow("maxPasses must be a positive integer.");
  });
});

function encodeTestHash({
  memoryKiB = 64,
  passes = 1,
  parallelism = 1,
  saltBytes = 16,
  tagBytes = 16,
}: {
  readonly memoryKiB?: number;
  readonly passes?: number;
  readonly parallelism?: number;
  readonly saltBytes?: number;
  readonly tagBytes?: number;
}): string {
  // The tag need not match because every test hash is rejected before derivation.
  return [
    "$argon2id$v=19",
    `m=${memoryKiB},t=${passes},p=${parallelism}`,
    Buffer.alloc(saltBytes).toString("base64url"),
    Buffer.alloc(tagBytes).toString("base64url"),
  ].join("$");
}
