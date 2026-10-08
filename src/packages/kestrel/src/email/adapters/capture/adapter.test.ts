import { describe, expect, it } from "vitest";

import { MemoryEmailCaptureStorageAdapter } from "../memory/index.js";
import { EmailClient } from "../../client.js";
import type { EmailSendError } from "../../errors.js";
import { EmailCaptureAdapter } from "./adapter.js";

describe("EmailCaptureAdapter", () => {
  it("links a persistent capture to the reserved send observation", async () => {
    const store = new MemoryEmailCaptureStorageAdapter();
    const client = new EmailClient({
      name: "development",
      driver: new EmailCaptureAdapter({
        store,
        createCaptureId: () => "00000000-0000-4000-8000-000000000010",
        now: () => new Date("2026-08-24T10:00:00.000Z"),
      }),
      createObservationId: () => "00000000-0000-4000-8000-000000000020",
    });

    const receipt = await client.send({
      from: "sender@example.com",
      to: "member@example.com",
      subject: "Welcome",
      text: "Hello",
    });
    const capture = await store.get(receipt.captureId!);

    expect(receipt).toEqual({
      status: "accepted",
      messageId: "00000000-0000-4000-8000-000000000010",
      captureId: "00000000-0000-4000-8000-000000000010",
      acceptedAt: new Date("2026-08-24T10:00:00.000Z"),
    });
    expect(capture).toMatchObject({
      id: receipt.captureId,
      observationId: "00000000-0000-4000-8000-000000000020",
      message: { subject: "Welcome" },
    });
  });

  it("rejects messages exceeding the configured capture boundary", async () => {
    const client = new EmailClient({
      name: "development",
      driver: new EmailCaptureAdapter({
        store: new MemoryEmailCaptureStorageAdapter(),
        maxMessageBytes: 100,
      }),
    });

    await expect(client.send({
      from: "sender@example.com",
      to: "member@example.com",
      subject: "Welcome",
      text: "x".repeat(200),
    })).rejects.toMatchObject({
      code: "invalid-message",
    } satisfies Partial<EmailSendError>);
  });
});
