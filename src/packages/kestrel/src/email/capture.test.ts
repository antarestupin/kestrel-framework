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

    await expect(inbox.resend("missing"))
      .rejects.toBeInstanceOf(EmailCaptureNotFoundError);
  });
});
