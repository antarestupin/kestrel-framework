import {
  describe,
  expect,
  it,
} from "vitest";

import {
  JsonWorkflowPayloadCodec,
  WorkflowPayloadSerializationError,
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

  it.each([
    [undefined, "unsupported undefined"],
    [1n, "unsupported bigint"],
    [Number.POSITIVE_INFINITY, "finite number"],
    [new Date(), "unsupported instance Date"],
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

    expect(() => codec.encode(value))
      .toThrow(WorkflowPayloadSerializationError);
  });
});
