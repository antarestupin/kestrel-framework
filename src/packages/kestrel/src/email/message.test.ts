import { describe, expect, it } from "vitest";

import { normalizeEmailMessage } from "./message.js";
import type { EmailMessageInput } from "./types.js";

const envelope = { from: "sender@example.test", to: "reader@example.test", subject: "Example" };
const message = { ...envelope, text: "Preserve whitespace\n" };

describe("email message normalization", () => {
  it.each([
    [null, "message must be an object"],
    [envelope, "requires a text or HTML body"],
    [{ ...message, to: [] }, "requires at least one address"],
    [{ ...message, from: "a@b@c" }, "contains an invalid address"],
    [{ ...message, from: "@example.test" }, "contains an invalid address"],
    [{ ...message, from: "sender@" }, "contains an invalid address"],
    [{ ...message, headers: null }, "headers must be a record"],
    [{ ...message, headers: [] }, "headers must be a record"],
    [{ ...message, headers: { "Invalid Header": "test" } }, "invalid name"],
    [{ ...message, headers: { "X-Label": 42 } }, "invalid value"],
    [{ ...message, headers: { "X-Label": "a\r\nBcc: spy@example.test" } }, "invalid value"],
    [{ ...message, attachments: {} }, "attachments must be an array"],
    [{ ...message, attachments: [null] }, "attachment must be an object"],
    [{ ...message, attachments: [{ filename: "x", content: [1] }] }, "content must be text or bytes"],
    [{ ...message, text: "" }, "must be a non-empty string"],
    [{ ...message, text: 42 }, "must be a non-empty string"],
    [{ ...message, subject: null }, "subject\" must be a string"],
    [{ ...message, subject: " " }, "invalid length"],
    [{ ...message, subject: "x".repeat(999) }, "invalid length"],
    [{ ...message, subject: "First\nSecond" }, "cannot contain a line break"],
  ])("rejects malformed input at the shared transport boundary (%s)", (input, error) => {
    expect(() => normalizeEmailMessage(input as EmailMessageInput)).toThrow(error);
  });

  it("detaches text and byte attachments without normalizing the message body", () => {
    const bytes = new Uint8Array([1, 2]);
    const headers = { "X-Label": "original" };
    const input = {
      ...message, from: { address: " sender@example.test ", name: " Sender " }, headers,
      attachments: [{ filename: "file.txt", content: "é" }, { filename: "file.bin", content: bytes }],
    };
    const normalized = normalizeEmailMessage(input);
    bytes[0] = 3;
    headers["X-Label"] = "changed";
    input.from.name = "Changed";

    expect(normalized.from).toEqual({ address: "sender@example.test", name: "Sender" });
    expect(normalized.headers).toEqual({ "X-Label": "original" });
    expect(normalized.text).toBe(message.text);
    expect(normalized.attachments.map(({ content }) => content)).toEqual(["é", new Uint8Array([1, 2])]);
    expect(Object.isFrozen(normalized.attachments)).toBe(true);
  });
});
