import { describe, expect, it, vi } from "vitest";

import { MemoryEmailCaptureStorageAdapter } from "./adapters/memory/index.js";
import {
  EmailCaptureInbox,
  EmailCaptureNotFoundError,
} from "./capture.js";
import { normalizeEmailMessage } from "./message.js";

describe("EmailCaptureInbox", () => {
  it("replays the original normalized message through its configured sender", async () => {
    const store = new MemoryEmailCaptureStorageAdapter();
    const send = vi.fn(async () => ({
      status: "accepted" as const,
      captureId: "capture-2",
    }));
    const inbox = new EmailCaptureInbox(store, send);
    const message = normalizeEmailMessage({
      from: "sender@example.com",
      to: "member@example.com",
      subject: "Message",
      text: "Body",
    });
    await store.capture({
      id: "capture-1",
      observationId: "observation-1",
      capturedAt: new Date("2026-08-24T10:00:00.000Z"),
      message,
    });

    await expect(inbox.resend("capture-1")).resolves.toEqual({
      receipt: { status: "accepted", captureId: "capture-2" },
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(message);
  });

  it("rejects replay of an expired or unknown capture", async () => {
    const inbox = new EmailCaptureInbox(
      new MemoryEmailCaptureStorageAdapter(),
      vi.fn(),
    );

    const outcome = inbox.resend("missing");
    await expect(outcome).rejects.toBeInstanceOf(EmailCaptureNotFoundError);
    await expect(outcome).rejects.toMatchObject({
      name: "EmailCaptureNotFoundError", message: 'Email capture "missing" does not exist.', captureId: "missing",
    });
  });

  it("routes capture, pagination, lookup and clear through the configured store", async () => {
    const store = new MemoryEmailCaptureStorageAdapter();
    const send = vi.fn();
    const inbox = new EmailCaptureInbox(store, send);
    const capturedAt = new Date("2026-08-24T10:00:00.000Z");
    const capture = {
      id: "capture-1", observationId: "observation-1", capturedAt,
      message: normalizeEmailMessage({
        from: { address: "sender@example.test", name: "Sender" }, to: "recipient@example.test",
        cc: "copy@example.test", bcc: "audit@example.test", subject: "Subject", text: "Body",
        attachments: [{ filename: "binary.bin", content: new Uint8Array([1, 2, 3]) }, { filename: "text.txt", content: "é" }],
      }),
    };

    await inbox.capture(capture);
    expect(await inbox.get(capture.id)).toEqual({ ...capture, sequence: 1 });
    const summary = (await inbox.list()).items[0];
    expect(summary).toStrictEqual({
      id: "capture-1", observationId: "observation-1", sequence: 1, capturedAt,
      from: { address: "sender@example.test", name: "Sender" }, to: [{ address: "recipient@example.test" }],
      cc: [{ address: "copy@example.test" }], bcc: [{ address: "audit@example.test" }],
      subject: "Subject", hasText: true, hasHtml: false, attachmentCount: 2, attachmentBytes: 5,
    });
    // Inbox views are detached from stored date and mailbox objects.
    summary?.capturedAt.setUTCFullYear(1900);
    Object.assign(summary?.from ?? {}, { address: "different@example.test" });
    expect((await inbox.list()).items[0]?.capturedAt).toEqual(capturedAt);
    expect((await inbox.list()).items[0]?.from.address).toBe("sender@example.test");
    await expect(inbox.list({ before: 1, limit: 1 })).resolves.toEqual({ items: [], nextBefore: null });
    await inbox.clear();
    await expect(inbox.get(capture.id)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
