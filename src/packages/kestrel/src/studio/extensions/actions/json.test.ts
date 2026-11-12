import { describe, expect, it, vi } from "vitest";

import { generateActionExample, isStudioActionJson } from "./json.js";

describe("Studio action JSON examples", () => {
  it("rejects array subclasses with inherited serialization hooks", () => {
    const toJSON = vi.fn(() => "substituted");
    class Example extends Array<number> {
      public toJSON(): string { return toJSON(); }
    }
    const example = new Example();
    example.push(1);
    expect(isStudioActionJson(example)).toBe(false);
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("rejects getters and non-JSON own properties without invoking them", () => {
    const read = vi.fn(() => 1);
    const getValue = Object.defineProperty({}, "value", { enumerable: true, get: read });
    const getElement = Object.defineProperty([1], 0, { enumerable: true, get: read });
    const hidden = Object.defineProperty({}, "value", { value: 1 });
    const annotatedArray = Object.assign([1], { label: "extra" });
    const sparse = new Array(2);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;

    for (const value of [
      getValue, getElement, hidden, annotatedArray, sparse, cycle,
      { [Symbol("field")]: true }, { n: Infinity }, [undefined], new Date(0),
    ]) {
      expect(isStudioActionJson(value)).toBe(false);
    }
    expect(read).not.toHaveBeenCalled();
    // Shared values are valid because only recursion back into an ancestor is a cycle.
    const shared = Object.assign(Object.create(null), { n: 1 });
    expect(isStudioActionJson({ a: shared, b: [shared, null, true, "ok"] })).toBe(true);
  });

  it("does not treat inherited names as known string formats", () => {
    expect(generateActionExample({ type: "string", format: "constructor" })).toBe("example");
  });

  it("respects explicit values and picks bounded starting values for common schemas", () => {
    expect(generateActionExample({
      type: "object",
      properties: {
        preferred: { default: null, const: true, examples: [3] },
        fixed: { const: false, examples: [3] },
        named: { examples: ["first"], enum: ["fallback"] },
        listed: { enum: ["first", "second"] },
        choice: { oneOf: [{ type: "integer", minimum: 0 }] },
        either: { anyOf: [{ type: "number" }] },
        rows: { type: "array" },
        enabled: { type: "boolean" },
        site: { type: "string", format: "uri" },
        open: {},
        empty: { type: "object" },
      },
    })).toEqual({
      preferred: null, fixed: false, named: "first", listed: "first",
      choice: 0, either: 1, rows: [], enabled: true, site: "https://example.com",
      open: null, empty: {},
    });
    expect(generateActionExample(false)).toBeNull();
    expect(generateActionExample({ type: "boolean" }, 9)).toBeNull();
  });
});
