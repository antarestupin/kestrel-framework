import { Buffer } from "node:buffer";
import { describe, expect, expectTypeOf, it } from "vitest";
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

});
