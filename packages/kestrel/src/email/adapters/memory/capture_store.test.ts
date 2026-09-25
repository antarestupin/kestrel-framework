import { describe, expect, it } from "vitest";

import { normalizeEmailMessage } from "../../message.js";
import { MemoryEmailCaptureStore } from "./capture_store.js";

describe("MemoryEmailCaptureStore", () => {
  it("paginates summaries without exposing bodies or attachment contents", async () => {
    const store = new MemoryEmailCaptureStore();

    for (const index of [1, 2]) {
      await store.capture({
        id: `capture-${index}`,
        observationId: `observation-${index}`,
        capturedAt: new Date(`2026-08-24T10:00:0${index}.000Z`),
        message: normalizeEmailMessage({
          from: "sender@example.com",
          to: `member-${index}@example.com`,
          subject: `Message ${index}`,
          html: `<p>Secret ${index}</p>`,
          attachments: [{ filename: "file.txt", content: "secret" }],
        }),
      });
    }

    const firstPage = await store.list({ limit: 1 });
    const secondPage = await store.list({
      before: firstPage.nextBefore!,
      limit: 1,
    });

    expect(firstPage.items).toEqual([expect.objectContaining({
      sequence: 2,
      id: "capture-2",
      observationId: "observation-2",
      hasHtml: true,
      attachmentCount: 1,
      attachmentBytes: 6,
    })]);
    expect(JSON.stringify(firstPage)).not.toContain("Secret");
    expect(JSON.stringify(firstPage)).not.toContain("secret");
    expect(secondPage.items[0]?.id).toBe("capture-1");
  });

  it("returns detached message copies and clears the inbox", async () => {
    const store = new MemoryEmailCaptureStore();
    await store.capture({
      id: "capture-1",
      observationId: "observation-1",
      capturedAt: new Date("2026-08-24T10:00:00.000Z"),
      message: normalizeEmailMessage({
        from: "sender@example.com",
        to: "member@example.com",
        subject: "Message",
        text: "Body",
      }),
    });

    const capture = await store.get("capture-1");
    expect(capture?.message.text).toBe("Body");

    await store.clear();
    await expect(store.get("capture-1")).resolves.toBeUndefined();
  });
});
