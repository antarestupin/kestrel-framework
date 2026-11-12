import { describe, expect, it } from "vitest";

import { EmailClient } from "../../client.js";
import { MemoryEmailAdapter } from "./adapter.js";

describe("MemoryEmailAdapter", () => {
  it("implements the driver contract with isolated captured snapshots", async () => {
    const adapter = new MemoryEmailAdapter({
      createMessageId: () => "message-1",
      now: () => new Date("2026-08-23T10:00:00.000Z"),
    });
    const client = new EmailClient({ name: "test", driver: adapter });

    const receipt = await client.send({
      from: "sender@example.com",
      to: "member@example.com",
      subject: "Welcome",
      text: "Hello",
    });
    const firstRead = adapter.getMessages();
    (firstRead[0]?.to as { address: string }[])[0]!.address = "changed@example.com";
    Object.assign(firstRead[0]?.from ?? {}, { address: "changed@example.com" });

    expect(receipt).toEqual({
      status: "accepted",
      messageId: "message-1",
      acceptedAt: new Date("2026-08-23T10:00:00.000Z"),
    });
    expect(adapter.getMessages()[0]).toStrictEqual({
      from: { address: "sender@example.com" }, to: [{ address: "member@example.com" }],
      cc: [], bcc: [], replyTo: [], subject: "Welcome", text: "Hello", attachments: [],
    });

    adapter.clear();
    expect(adapter.getMessages()).toEqual([]);
  });
});

it("clones HTML, headers and text and binary attachments on every read", async () => {
  const adapter = new MemoryEmailAdapter({ name: "local" });
  const client = new EmailClient({ name: "test", driver: adapter });
  const receipt = await client.send({
    from: "sender@example.com", to: "member@example.com", subject: "Welcome", html: "<p>Hello</p>",
    headers: { "X-Test": "unchanged" },
    attachments: [{ filename: "file.txt", content: "text" }, { filename: "file.bin", content: new Uint8Array([1, 2]) }],
  });
  const message = adapter.getMessages()[0]!;
  (message.attachments[1]!.content as Uint8Array)[0] = 9;
  (message.headers as Record<string, string>)["X-Test"] = "changed";
  expect(adapter.name).toBe("local");
  expect(receipt).toMatchObject({ status: "accepted", messageId: expect.any(String), acceptedAt: expect.any(Date) });
  expect(adapter.getMessages()[0]).toStrictEqual({
    from: { address: "sender@example.com" }, to: [{ address: "member@example.com" }],
    cc: [], bcc: [], replyTo: [], subject: "Welcome", html: "<p>Hello</p>", headers: { "X-Test": "unchanged" },
    attachments: [{ filename: "file.txt", content: "text" }, { filename: "file.bin", content: new Uint8Array([1, 2]) }],
  });
});
