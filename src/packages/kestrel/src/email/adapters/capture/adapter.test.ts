import { describe, expect, it } from "vitest";

import { MemoryEmailCaptureStorageAdapter } from "../memory/index.js";
import { EmailClient } from "../../client.js";
import type { EmailSendError } from "../../errors.js";
import { normalizeEmailMessage } from "../../message.js";
import { EmailCaptureAdapter } from "./adapter.js";
import { captureEmailConfigBase } from "./configuration.js";

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

  it.each([0, -1, 1.5])("rejects an invalid local capture size limit %s", (maxMessageBytes) => {
    expect(() => new EmailCaptureAdapter({ store: new MemoryEmailCaptureStorageAdapter(), maxMessageBytes }))
      .toThrow("Email capture maxMessageBytes must be a positive integer.");
  });

  it("includes envelope, alternative bodies, metadata and raw attachment bytes in the exact limit", async () => {
    const store = new MemoryEmailCaptureStorageAdapter();
    const normalized = normalizeEmailMessage({
      from: "sender@example.test", to: "reader@example.test", subject: "Café", text: "é", html: "<p>é</p>",
      headers: { "X-Name": "été" }, attachments: [
        { filename: "a.txt", content: "é" }, { filename: "b.bin", content: new Uint8Array([0, 255]) },
      ],
    });
    // The envelope and attachment metadata are JSON, while bodies and contents use UTF-8 byte lengths.
    const envelope = '{"from":{"address":"sender@example.test"},"to":[{"address":"reader@example.test"}],"cc":[],"bcc":[],"replyTo":[],"subject":"Café","headers":{"X-Name":"été"},"attachments":[{"filename":"a.txt"},{"filename":"b.bin"}]}';
    const size = Buffer.byteLength(envelope) + 2 + 9 + 2 + 2;
    const context = { observationId: "send-1" };
    await expect(new EmailCaptureAdapter({ store, maxMessageBytes: size - 1 }).send(normalized, context))
      .rejects.toMatchObject({ code: "invalid-message", message: "The email exceeds the local capture size limit." });
    expect((await store.list()).items).toHaveLength(0);
    await expect(new EmailCaptureAdapter({ store, maxMessageBytes: size }).send(normalized, context))
      .resolves.toMatchObject({ status: "accepted" });

    const { text: _text, ...htmlOnly } = normalized;
    await expect(new EmailCaptureAdapter({ store, maxMessageBytes: size - 2 }).send(htmlOnly, context))
      .resolves.toMatchObject({ status: "accepted" });
  });
});

it("resolves a 10 MiB capture default and validates deployment overrides", () => {
  expect(captureEmailConfigBase.schema.parse({})).toEqual({ maxMessageBytes: 10_485_760 });
  expect(captureEmailConfigBase.schema.parse({ maxMessageBytes: "4096" })).toEqual({ maxMessageBytes: 4096 });
  for (const maxMessageBytes of [0, "-1", "1.5", "invalid"]) {
    expect(captureEmailConfigBase.schema.safeParse({ maxMessageBytes }).success).toBe(false);
  }
});
