import { describe, expect, it } from "vitest";

import { generateExampleValue } from "./schema_examples.js";

describe("Studio HTTP input examples", () => {
  it("handles boolean schemas and falls back when examples and alternatives are empty", () => {
    expect(generateExampleValue(false)).toBeUndefined();
    expect(generateExampleValue(true)).toBe("example");
    expect(generateExampleValue({ type: "number", minimum: 0, examples: [], oneOf: [], anyOf: [] })).toBe(0);
  });

  it("keeps tuple positions and honors both ways to declare an empty array", () => {
    expect(generateExampleValue({
      type: "array", prefixItems: [{ const: false }, { type: "number", minimum: -3 }],
    })).toEqual([false, -3]);
    expect(generateExampleValue({ type: "array", maxItems: 0, items: { type: "boolean" } })).toEqual([]);
    expect(generateExampleValue({ type: "array", items: false })).toEqual([]);
    expect(generateExampleValue({ type: "array", items: [{ type: "boolean" }] })).toEqual([true]);
    expect(generateExampleValue({ type: "array", items: [] })).toEqual([]);
    expect(generateExampleValue({ type: "array" })).toEqual([]);
  });

  it("uses an empty object when the schema has no property record", () => {
    expect(generateExampleValue({ type: "object", properties: null })).toEqual({});
    expect(generateExampleValue({ type: "object", properties: "invalid" })).toEqual({});
  });

  it.each(["url", "uri"])("generates an absolute value for %s fields", (format) => {
    expect(generateExampleValue({ type: "string", format })).toBe("https://example.com");
  });
});
