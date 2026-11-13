import { argon2, argon2Sync, type Argon2Parameters } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import { Argon2idPasswordHasher } from "./hasher.js";

const password = "correct horse battery staple";
const inexpensive = { memoryKiB: 64, passes: 1, parallelism: 1, saltBytes: 16, tagBytes: 16 };
const fixedSalt = (bytes: number) => Uint8Array.from({ length: bytes }, (_, index) => index);
const parameterCases = [
  ["memoryKiB", "maxMemoryKiB", 65],
  ["passes", "maxPasses", 2],
  ["parallelism", "maxParallelism", 2],
  ["saltBytes", "maxSaltBytes", 17],
  ["tagBytes", "maxTagBytes", 17],
] as const;

/** Valid hashes distinguish a rejected verification budget from a wrong-password result. */
describe("Argon2id password resource and secret contracts", () => {
  it("settles a successful native callback and encodes its derived tag", async () => {
    const salt = fixedSalt(16);
    const tag = Buffer.alloc(16, 7);
    const native = vi.fn<typeof argon2>((_algorithm, _parameters, callback) => {
      queueMicrotask(() => callback(null, tag));
    });
    vi.resetModules();
    vi.doMock("node:crypto", async (importOriginal) => ({
      ...await importOriginal<typeof import("node:crypto")>(),
      argon2: native,
    }));
    try {
      const { Argon2idPasswordHasher: ControlledHasher } = await import("./hasher.js");
      const hasher = new ControlledHasher({ ...inexpensive, createSalt: fixedSalt });
      let outcome: { error: unknown } | { value: unknown } | undefined;
      void hasher.hash(password).then(
        (value) => { outcome = { value }; },
        (error: unknown) => { outcome = { error }; },
      );
      // Flush the injected callback and promise continuations and then assert settlement.
      await setImmediate();
      expect(native).toHaveBeenCalledExactlyOnceWith("argon2id", {
        message: password, nonce: salt, parallelism: 1, tagLength: 16, memory: 64, passes: 1,
      } satisfies Argon2Parameters, expect.any(Function));
      expect(outcome).toEqual({ value: `$argon2id$v=19$m=64,t=1,p=1$${Buffer.from(salt).toString("base64url")}$${tag.toString("base64url")}` });
    } finally {
      vi.doUnmock("node:crypto");
      vi.resetModules();
    }
  });

  for (const [parameter, limit, value] of parameterCases) {
    it(`refuses a valid hash immediately above the ${limit} budget`, async () => {
      const parameters = { ...inexpensive, [parameter]: value };
      const salt = fixedSalt(parameters.saltBytes);
      const tag = argon2Sync("argon2id", {
        message: password, nonce: salt, memory: parameters.memoryKiB, passes: parameters.passes,
        parallelism: parameters.parallelism, tagLength: parameters.tagBytes,
      });
      const encoded = `$argon2id$v=19$m=${parameters.memoryKiB},t=${parameters.passes},p=${parameters.parallelism}$${Buffer.from(salt).toString("base64url")}$${tag.toString("base64url")}`;
      const verifier = new Argon2idPasswordHasher({ ...inexpensive, verificationLimits: { [limit]: inexpensive[parameter] } });
      let refused: boolean | undefined;
      let refusalError: unknown;
      void verifier.verify(password, encoded).then((valid) => { refused = valid; }, (error: unknown) => { refusalError = error; });
      // An over-budget hash settles in JavaScript before any native derivation.
      await setImmediate();
      expect(refusalError).toBeUndefined();
      expect(refused).toBe(false);
      expect(verifier.needsRehash(encoded)).toBe(true);
      // The exact budget accepts this hash, while the distinct generation policy requires a rehash.
      const boundary = new Argon2idPasswordHasher({ ...inexpensive, verificationLimits: { [limit]: value } });
      await expect(boundary.verify(password, encoded)).resolves.toBe(true);
      expect(boundary.needsRehash(encoded)).toBe(true);
    });
  }

  it("accepts permitted multi-digit pass and parallelism parameters", async () => {
    const hasher = new Argon2idPasswordHasher({ ...inexpensive, memoryKiB: 96, passes: 10, parallelism: 12, createSalt: fixedSalt });
    const encoded = await hasher.hash(password);
    await expect(hasher.verify(password, encoded)).resolves.toBe(true);
    expect(hasher.needsRehash(encoded)).toBe(false);
  });

  it("binds password hashes to the configured pepper for creation and verification", async () => {
    const options = { ...inexpensive, createSalt: fixedSalt };
    const peppered = new Argon2idPasswordHasher({ ...options, pepper: Buffer.from("first server secret") });
    const samePepper = new Argon2idPasswordHasher({ ...options, pepper: Buffer.from("first server secret") });
    const wrongPepper = new Argon2idPasswordHasher({ ...options, pepper: Buffer.from("second server secret") });
    const unpeppered = new Argon2idPasswordHasher(options);
    const encoded = await peppered.hash(password);
    const plain = await unpeppered.hash(password);
    expect(encoded).not.toBe(plain);
    await expect(samePepper.verify(password, encoded)).resolves.toBe(true);
    await expect(wrongPepper.verify(password, encoded)).resolves.toBe(false);
    await expect(unpeppered.verify(password, encoded)).resolves.toBe(false);
    await expect(peppered.verify(password, plain)).resolves.toBe(false);
  });

  it("retains its configured pepper after the application clears its input buffer", async () => {
    const pepper = Buffer.from("temporary application secret buffer");
    const hasher = new Argon2idPasswordHasher({ ...inexpensive, createSalt: fixedSalt, pepper });
    const encoded = await hasher.hash(password);

    // Clearing the caller's copy must leave existing credentials usable.
    pepper.fill(0);
    await expect(hasher.verify(password, encoded)).resolves.toBe(true);
    await expect(hasher.hash(password)).resolves.toBe(encoded);
  });

  it("requires the complete encoded hash without extra prefixes or suffixes", async () => {
    const hasher = new Argon2idPasswordHasher({ ...inexpensive, createSalt: fixedSalt });
    const encoded = await hasher.hash(password);
    for (const malformed of [`prefix${encoded}`, `${encoded}$suffix`]) {
      await expect(hasher.verify(password, malformed)).resolves.toBe(false);
      expect(hasher.needsRehash(malformed)).toBe(true);
    }
  });

  for (const parameter of ["saltBytes", "tagBytes"] as const) {
    it(`refuses a cryptographically valid stored hash below the ${parameter} security minimum`, async () => {
      const parameters = { ...inexpensive, [parameter]: 15 };
      const salt = fixedSalt(parameters.saltBytes);
      // Native Argon2 accepts these sizes, but Kestrel deliberately requires at least 16 bytes.
      // A real matching tag prevents an incorrect derivation from looking like a safe rejection.
      const tag = await new Promise<Buffer>((resolve, reject) => {
        argon2("argon2id", { message: password, nonce: salt, memory: parameters.memoryKiB, passes: parameters.passes, parallelism: parameters.parallelism, tagLength: parameters.tagBytes }, (error, value) => {
          if (error !== null) reject(error);
          else resolve(value);
        });
      });
      const encoded = `$argon2id$v=19$m=64,t=1,p=1$${Buffer.from(salt).toString("base64url")}$${tag.toString("base64url")}`;
      const hasher = new Argon2idPasswordHasher(inexpensive);
      await expect(hasher.verify(password, encoded)).resolves.toBe(false);
      expect(hasher.needsRehash(encoded)).toBe(true);
    });
  }

  it("rejects stored parameters with insufficient memory per lane before native derivation", async () => {
    const hasher = new Argon2idPasswordHasher(inexpensive);
    const field = Buffer.alloc(16).toString("base64url");
    // This native-invalid parameter combination must resolve false instead of rejecting verification.
    await expect(hasher.verify(password, `$argon2id$v=19$m=15,t=1,p=2$${field}$${field}`)).resolves.toBe(false);
  });

  it("caches one usable dummy hash and retains the public algorithm identity", async () => {
    const createSalt = vi.fn(fixedSalt);
    const hasher = new Argon2idPasswordHasher({ ...inexpensive, createSalt });
    const first = hasher.getDummyHash();
    expect(hasher.getDummyHash()).toBe(first);
    const encoded = await first;
    expect(hasher.getDummyHash()).toBe(first);
    expect(createSalt).toHaveBeenCalledExactlyOnceWith(16);
    expect(encoded.split("$").at(-2)).toBe(Buffer.from(fixedSalt(16)).toString("base64url"));
    // The dummy password is an internal timing fixture; only the reusable hash contract matters.
    expect(encoded).toMatch(/^\$argon2id\$v=19\$/);
    expect(hasher.needsRehash(encoded)).toBe(false);
    expect(hasher.id).toBe("argon2id");
  });

  // Invalid generation settings must fail synchronously, before expensive native derivation.
  for (const parameter of ["memoryKiB", "passes", "parallelism", "saltBytes", "tagBytes"] as const) {
    for (const value of [0, -1, 1.5]) {
      it(`rejects invalid generation ${parameter} ${value}`, () => {
        expect(() => new Argon2idPasswordHasher({ ...inexpensive, [parameter]: value }))
          .toThrow(`${parameter} must be a positive integer.`);
      });
    }
  }

  for (const limit of ["maxEncodedHashChars", "maxMemoryKiB", "maxPasses", "maxParallelism", "maxSaltBytes", "maxTagBytes"] as const) {
    it(`rejects a fractional ${limit} verification budget`, () => {
      expect(() => new Argon2idPasswordHasher({ ...inexpensive, verificationLimits: { [limit]: 1.5 } })).toThrow(TypeError);
    });
  }

  it("requires enough memory per lane while accepting the exact minimum", async () => {
    expect(() => new Argon2idPasswordHasher({ ...inexpensive, memoryKiB: 15, parallelism: 2 }))
      .toThrow("Argon2id memory is too small for its parallelism.");
    const hasher = new Argon2idPasswordHasher({ ...inexpensive, memoryKiB: 16, parallelism: 2, createSalt: fixedSalt });
    const encoded = await hasher.hash(password);
    await expect(hasher.verify(password, encoded)).resolves.toBe(true);
  });

  for (const [parameter, label] of [["saltBytes", "salts"], ["tagBytes", "tags"]] as const) {
    it(`rejects generation with an undersized ${parameter}`, () => {
      expect(() => new Argon2idPasswordHasher({ ...inexpensive, [parameter]: 15 }))
        .toThrow(`Argon2id ${label} must contain at least 16 bytes.`);
    });
  }

  it("requires the entire generated encoding to fit the configured character budget", async () => {
    const source = new Argon2idPasswordHasher({ ...inexpensive, createSalt: fixedSalt });
    const encoded = await source.hash(password);
    const within = new Argon2idPasswordHasher({ ...inexpensive, verificationLimits: { maxEncodedHashChars: encoded.length } });
    await expect(within.verify(password, encoded)).resolves.toBe(true);
    expect(() => new Argon2idPasswordHasher({ ...inexpensive, verificationLimits: { maxEncodedHashChars: encoded.length - 1 } })).toThrow(TypeError);
  });
});
