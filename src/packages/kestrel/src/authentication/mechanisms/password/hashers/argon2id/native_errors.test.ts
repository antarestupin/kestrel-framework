import { argon2Sync, type argon2 } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { Argon2idPasswordHasher } from "./hasher.js";

const options = { memoryKiB: 64, passes: 1, parallelism: 1, saltBytes: 16, tagBytes: 16 };
const password = "correct-password";
const salt = Buffer.alloc(16, 5);
// A reference encoding uses the independent synchronous entry point, so a mutant
// that strands the asynchronous wrapper cannot strand test setup as well.
const tag = argon2Sync("argon2id", {
  message: password, nonce: salt, parallelism: 1, tagLength: 16, memory: 64, passes: 1,
});
const encoded = `$argon2id$v=19$m=64,t=1,p=1$${salt.toString("base64url")}$${tag.toString("base64url")}`;

for (const operation of ["hash", "verify", "getDummyHash"] as const) {
  it(`propagates the original native callback error from ${operation} without leaving a pending promise`, async () => {
    const failure = new Error("Native Argon2 provider failed");
    const native = vi.fn<typeof argon2>((_algorithm, _parameters, callback) => {
      // Native failures do not provide a usable result; the wrapper must reject with the cause.
      queueMicrotask(() => callback(failure, undefined as unknown as Buffer<ArrayBuffer>));
    });
    vi.resetModules();
    vi.doMock("node:crypto", async (importOriginal) => ({
      ...await importOriginal<typeof import("node:crypto")>(),
      argon2: native,
    }));
    try {
      // Resetting the module cache lets this import use the mock without mutating Node globals.
      const { Argon2idPasswordHasher: FaultedHasher } = await import("./hasher.js");
      const hasher = new FaultedHasher(options);
      const pending = operation === "hash" ? hasher.hash(password)
        : operation === "verify" ? hasher.verify(password, encoded)
          : hasher.getDummyHash();
      let outcome: { error: unknown } | { value: unknown } | undefined;
      void pending.then(
        (value) => { outcome = { value }; },
        (error: unknown) => { outcome = { error }; },
      );
      // The injected callback and promise continuations have no I/O. Drain them once,
      // then assert settlement directly rather than relying on a five-second test timeout.
      await setImmediate();
      expect(native).toHaveBeenCalledOnce();
      expect(outcome).toEqual({ error: failure });
      expect(outcome && "error" in outcome && outcome.error).toBe(failure);
    } finally {
      // Non-isolated suites must never inherit the mocked provider or its cached hasher module.
      vi.doUnmock("node:crypto");
      vi.resetModules();
    }
  });
}

it("rejects a malformed tag returned by the native provider without throwing", async () => {
  vi.resetModules();
  vi.doMock("node:crypto", async (importOriginal) => ({
    ...await importOriginal<typeof import("node:crypto")>(),
    argon2: ((_algorithm, _parameters, callback) => {
      // The constant-time comparison requires equal-sized buffers.
      callback(null, Buffer.alloc(1));
    }) satisfies typeof argon2,
  }));
  try {
    const { Argon2idPasswordHasher: FaultedHasher } = await import("./hasher.js");
    let outcome: { error: unknown } | { value: unknown } | undefined;
    void new FaultedHasher(options).verify(password, encoded).then(
      (value) => { outcome = { value }; },
      (error: unknown) => { outcome = { error }; },
    );
    await setImmediate();
    expect(outcome).toEqual({ value: false });
  } finally {
    vi.doUnmock("node:crypto");
    vi.resetModules();
  }
});

it("restores the real provider after the controlled native callbacks", async () => {
  expect(await new Argon2idPasswordHasher(options).verify(password, encoded)).toBe(true);
});
