import type { argon2 } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { Argon2idPasswordHasher } from "./hasher.js";

const options = { memoryKiB: 64, passes: 1, parallelism: 1, saltBytes: 16, tagBytes: 16 };

for (const operation of ["hash", "verify", "getDummyHash"] as const) {
  it(`propagates the original native callback error from ${operation} without leaving a pending promise`, async () => {
    // Generate a valid encoding with the real provider before replacing only the module import.
    const encoded = await new Argon2idPasswordHasher(options).hash("correct-password");
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
      const pending = operation === "hash" ? hasher.hash("correct-password")
        : operation === "verify" ? hasher.verify("correct-password", encoded)
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
    const { Argon2idPasswordHasher: RestoredHasher } = await import("./hasher.js");
    const restored = new RestoredHasher(options);
    expect(await restored.verify("correct-password", await restored.hash("correct-password"))).toBe(true);
  });
}

it("rejects a malformed tag returned by the native provider without throwing", async () => {
  const encoded = await new Argon2idPasswordHasher(options).hash("correct-password");
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
    await expect(new FaultedHasher(options).verify("correct-password", encoded)).resolves.toBe(false);
  } finally {
    vi.doUnmock("node:crypto");
    vi.resetModules();
  }
});
