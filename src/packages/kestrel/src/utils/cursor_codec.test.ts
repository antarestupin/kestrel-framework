import { Buffer } from "node:buffer";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { createPaginationCursorCodec } from "./cursor_codec.js";

const cursorSchema = z.object({ id: z.number().int(), label: z.string() });
const cursorCodec = createPaginationCursorCodec(cursorSchema);

/** Constructs intentionally invalid envelopes without using the validating encoder. */
function token(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("pagination cursor codec", () => {
  it("round-trips typed Unicode cursors as URL-safe tokens", () => {
    const cursor = { id: 0, label: "雪 / + ? &" };
    const encoded = z.encode(cursorCodec, cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(z.decode(cursorCodec, encoded)).toEqual(cursor);
    expectTypeOf(z.decode(cursorCodec, encoded)).toEqualTypeOf<z.output<typeof cursorSchema>>();
  });

  it.each([
    "", "%%%", "a", "e30=", token({}), token({ version: 2, value: { id: 1, label: "one" } }),
    token({ version: 1, value: null }), token({ version: 1, value: { id: "wrong", label: "one" } }),
    Buffer.from("not json").toString("base64url"), "a".repeat(4097),
  ])("rejects an invalid cursor token %s", (encoded) => {
    expect(cursorCodec.safeParse(encoded).success).toBe(false);
  });

  it("rejects unsupported serialization and excessive encoded length", () => {
    expect(() => z.encode(createPaginationCursorCodec(z.date()), new Date())).toThrow(z.ZodError);
    expect(() => z.encode(createPaginationCursorCodec(z.bigint()), 12n)).toThrow(z.ZodError);
    expect(() => z.encode(createPaginationCursorCodec(cursorSchema, { maxLength: 10 }), { id: 1, label: "one" }))
      .toThrow(z.ZodError);
    expect(() => createPaginationCursorCodec(cursorSchema, { maxLength: 0 })).toThrow(TypeError);
  });

  it("checks canonical base64url, UTF-8, and envelope contents before decoding a value", () => {
    const codec = createPaginationCursorCodec(z.unknown());
    const valid = token({ version: 1, value: "a" });
    // Both final characters decode to the same bytes, but only one has zero padding bits.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const noncanonical = valid.slice(0, -1) + alphabet[alphabet.indexOf(valid.at(-1)!) + 1];
    expect(Buffer.from(noncanonical, "base64url")).toEqual(Buffer.from(valid, "base64url"));
    const invalidUtf8 = Buffer.from('{"version":1,"value":"a"}');
    invalidUtf8[invalidUtf8.lastIndexOf(0x61)] = 0xff;

    for (const encoded of [
      noncanonical, invalidUtf8.toString("base64url"), token({ version: 1 }), token({ version: 1, value: null }),
      token({ version: 1, value: "a", extra: true }),
    ]) {
      expect(codec.safeDecode(encoded)).toMatchObject({
        success: false,
        error: { issues: [expect.objectContaining({ code: "custom", message: "Invalid pagination cursor." })] },
      });
    }
    expect(z.decode(codec, valid)).toBe("a");

    // A token with an invalid character is rejected at the wire-format boundary.
    for (const encoded of [`!${valid}`, `${valid}!`]) {
      expect(codec.safeDecode(encoded)).toMatchObject({
        success: false,
        error: { issues: [expect.objectContaining({ code: "invalid_format", format: "regex" })] },
      });
    }
  });

  it("preserves nested JSON values and accepts the exact maximum token length", () => {
    const value = { values: [null, false, -1, 1.25, "text", { toJSON: "ordinary data" }] };
    const encoded = token({ version: 1, value });
    const codec = createPaginationCursorCodec(z.unknown(), { maxLength: encoded.length });
    expect(z.encode(codec, value)).toBe(encoded);
    expect(z.decode(codec, encoded)).toEqual(value);
    expect(codec.safeDecode(encoded + "a").success).toBe(false);
    expect(() => createPaginationCursorCodec(z.unknown(), { maxLength: 1 })).not.toThrow();
  });

  it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid maximum length %s at construction",
    (maxLength) => {
      expect(() => createPaginationCursorCodec(z.unknown(), { maxLength })).toThrow(
        "The maximum cursor length must be a positive safe integer.",
      );
    },
  );

  it("rejects JSON values that would change during serialization", () => {
    const codec = createPaginationCursorCodec(z.unknown());
    const circular: unknown[] = [];
    class CursorPosition {
      readonly id = 5;
    }
    circular.push(circular);
    for (const value of [
      null, undefined, NaN, Infinity, { value: undefined }, [undefined], Array(1),
      Symbol("cursor"), { value: new Date(0) }, new CursorPosition(), circular,
    ]) {
      expect(codec.safeEncode(value)).toMatchObject({
        success: false,
        error: {
          issues: [expect.objectContaining({
            code: "custom",
            message: "Cursor values must have a lossless JSON representation.",
          })],
        },
      });
    }
  });

  it("rejects serialization hooks before they can replace validated cursor data", () => {
    const replace = vi.fn(() => ["replacement"]);
    const array = Object.defineProperty(["original"], "toJSON", { value: replace });
    const object = Object.defineProperty({ original: true }, "toJSON", { value: replace });
    const codec = createPaginationCursorCodec(z.unknown());

    for (const value of [array, { nested: object }]) {
      expect(codec.safeEncode(value)).toMatchObject({
        success: false,
        error: { issues: [expect.objectContaining({ message: "Cursor values must have a lossless JSON representation." })] },
      });
    }
    expect(replace).not.toHaveBeenCalled();
  });

  it("serializes the same values that were checked when a property is read", () => {
    const read = vi.fn().mockReturnValueOnce("checked").mockReturnValue(undefined);
    const value = Object.defineProperty({}, "position", { get: read, enumerable: true });
    const codec = createPaginationCursorCodec(z.unknown());

    expect(z.decode(codec, z.encode(codec, value))).toEqual({ position: "checked" });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
