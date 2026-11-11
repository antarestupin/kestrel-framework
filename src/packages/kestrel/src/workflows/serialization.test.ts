import {
  describe,
  expect,
  it,
} from "vitest";

import {
  JsonWorkflowPayloadCodec,
} from "./index.js";

describe("JsonWorkflowPayloadCodec", () => {
  it("copies JSON-compatible values in both directions", () => {
    const codec = new JsonWorkflowPayloadCodec();
    const source = {
      nested: [{ value: "example" }],
      count: 2,
      enabled: true,
      empty: null,
    };

    const encoded = codec.encode(source);
    const decoded = codec.decode(encoded);

    expect(encoded).toEqual(source);
    expect(encoded).not.toBe(source);
    expect(decoded).toEqual(source);
    expect(decoded).not.toBe(encoded);
  });

  it("produces the same dense payload as a JSON persistence round trip", () => {
    const codec = new JsonWorkflowPayloadCodec();
    // Array-valued payloads must use their indexed values even with a custom map method.
    const array = Object.assign([false, "", -0, null], { map: () => [] });
    const value = codec.encode(Object.assign(Object.create(null), { array }));
    expect(value).toStrictEqual({ array: [false, "", 0, null] });
    expect(JSON.parse(JSON.stringify(value))).toStrictEqual(value);
    expect(codec.decode(value)).toStrictEqual(value);
  });

  it("rejects sparse array entries at their exact payload path", () => {
    const codec = new JsonWorkflowPayloadCodec();
    const items = new Array(2);
    items[0] = null;
    expect(() => codec.encode({ items })).toThrow(expect.objectContaining({
      name: "WorkflowPayloadSerializationError", path: "$.items[1]",
    }));
  });

  it("encodes shared references independently without confusing them with cycles", () => {
    const codec = new JsonWorkflowPayloadCodec();
    const shared = { value: true };
    const result = codec.encode([shared, shared]) as readonly object[];
    expect(result).toStrictEqual([shared, shared]);
    expect(result[0]).not.toBe(result[1]);
    expect(result[0]).not.toBe(shared);
  });

  it("reports unsupported instance paths without reading a poisoned constructor property", () => {
    const codec = new JsonWorkflowPayloadCodec();
    const date = new Date(0);
    Object.defineProperty(date, "constructor", { get() { throw new Error("caller getter invoked"); } });
    expect(() => codec.encode({ date })).toThrow(expect.objectContaining({
      name: "WorkflowPayloadSerializationError", path: "$.date", message: expect.stringContaining("Date"),
    }));
  });

  it("reports unsupported instances without constructor metadata", () => {
    const codec = new JsonWorkflowPayloadCodec();
    const unsupported = Object.create(Object.create(null));
    expect(() => codec.encode({ unsupported })).toThrow(expect.objectContaining({
      name: "WorkflowPayloadSerializationError", path: "$.unsupported", message: expect.stringContaining("instance object"),
    }));
  });

  it.each([
    [undefined, "unsupported undefined"],
    [1n, "unsupported bigint"],
    [Number.POSITIVE_INFINITY, "finite number"],
    // Keep the parameterized test name stable across Stryker's filtered reruns.
    [new Date("2026-01-01T00:00:00.000Z"), "unsupported instance Date"],
  ])("rejects unsupported durable value %s", (value, message) => {
    const codec = new JsonWorkflowPayloadCodec();

    expect(() => codec.encode(value)).toThrow(message);
  });

  it("reports the path of nested invalid values", () => {
    const codec = new JsonWorkflowPayloadCodec();

    expect(() => codec.encode({ items: [{ value: undefined }] }))
      .toThrow("$.items[0].value");
  });

  it("rejects cyclic values", () => {
    const codec = new JsonWorkflowPayloadCodec();
    const value: { self?: unknown } = {};
    value.self = value;

    expect(() => codec.encode(value)).toThrow(expect.objectContaining({
      name: "WorkflowPayloadSerializationError", path: "$.self", message: expect.stringContaining("cycle"),
    }));
  });
});
