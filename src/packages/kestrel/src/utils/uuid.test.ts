import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createUuid } from "./uuid.js";

afterEach(() => {
  // Restore the shared runtime for Vitest's non-isolated test workers.
  vi.restoreAllMocks();
});

describe("createUuid", () => {
  it("matches the RFC 9562 Appendix A.6 vector", () => {
    vi.spyOn(Date, "now").mockReturnValue(1645557742000);
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      // Deliberately supply different version/variant bits to check masking.
      (array as Uint8Array).set([
        0, 0, 0, 0, 0, 0, 0xcc, 0xc3,
        0xd8, 0xc4, 0xdc, 0x0c, 0x0c, 0x07, 0x39, 0x8f,
      ]);
      return array;
    });

    expect(createUuid()).toBe("017f22e2-79b0-7cc3-98c4-dc0c0c07398f");
  });

  it.each([0, 0xffffffff, 0x100000000, 0xffffffffffff])(
    "preserves all timestamp bits at %i milliseconds",
    (timestamp) => {
      vi.spyOn(Date, "now").mockReturnValue(timestamp);
      const id = createUuid();

      expect(z.uuidv7().safeParse(id).success).toBe(true);
      expect(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16))
        .toBe(timestamp);
    },
  );

  it("orders distinct milliseconds and follows clock rollback without shared state", () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1645557742000)
      .mockReturnValueOnce(1645557742001)
      .mockReturnValueOnce(1645557741999);
    const first = createUuid();
    const second = createUuid();
    const rolledBack = createUuid();

    expect(first < second).toBe(true);
    expect(rolledBack < first).toBe(true);
  });

  it("uses fresh cryptographic randomness for calls within the same millisecond", () => {
    vi.spyOn(Date, "now").mockReturnValue(1645557742000);
    const random = vi.spyOn(globalThis.crypto, "getRandomValues");
    const ids = Array.from({ length: 1000 }, () => createUuid());

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => z.uuidv7().safeParse(id).success)).toBe(true);
    expect(random).toHaveBeenCalledTimes(ids.length);
  });

  it.each([-1, 0x1000000000000, 1.5, NaN, Infinity])(
    "rejects the unsupported timestamp %s",
    (timestamp) => {
      vi.spyOn(Date, "now").mockReturnValue(timestamp);
      expect(() => createUuid()).toThrow(RangeError);
    },
  );

  it("propagates entropy failures without falling back to weak randomness", () => {
    const error = new Error("Entropy unavailable");
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      throw error;
    });
    expect(() => createUuid()).toThrow(error);
  });
});
