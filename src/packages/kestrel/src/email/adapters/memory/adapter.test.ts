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

    expect(receipt).toEqual({
      status: "accepted",
      messageId: "message-1",
      acceptedAt: new Date("2026-08-23T10:00:00.000Z"),
    });
    expect(adapter.getMessages()[0]?.to[0]?.address).toBe("member@example.com");

    adapter.clear();
    expect(adapter.getMessages()).toEqual([]);
  });
});
