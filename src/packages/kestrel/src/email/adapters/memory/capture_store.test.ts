import { describe, expect, it } from "vitest";

import { normalizeEmailMessage } from "../../message.js";
import { MemoryEmailCaptureStorageAdapter } from "./capture_store.js";

describe("MemoryEmailCaptureStorageAdapter", () => {
  it("paginates summaries without exposing bodies or attachment contents", async () => {
    const store = new MemoryEmailCaptureStorageAdapter();

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
      hasText: false,
      hasHtml: true,
      attachmentCount: 1,
      attachmentBytes: 6,
    })]);
    expect(JSON.stringify(firstPage)).not.toContain("Secret");
    expect(JSON.stringify(firstPage)).not.toContain("secret");
    expect(secondPage.items[0]?.id).toBe("capture-1");
  });

  it("returns detached message copies and clears the inbox", async () => {
    const store = new MemoryEmailCaptureStorageAdapter();
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

  it("enforces unique capture IDs and bounded, gap-free descending pagination", async () => {
    const store = new MemoryEmailCaptureStorageAdapter();
    const message = normalizeEmailMessage({ from: "sender@example.test", to: "reader@example.test", subject: "Message", text: "Body" });
    const newCapture = (sequence: number) => ({ id: `capture-${sequence}`, observationId: `observation-${sequence}`,
      capturedAt: new Date("2026-08-24T10:00:00.000Z"), message });
    for (let sequence = 1; sequence <= 101; sequence += 1) {
      await store.capture(newCapture(sequence));
    }
    await expect(store.capture(newCapture(3))).rejects.toThrow('Email capture "capture-3" already exists.');
    const initial = await store.list();
    expect(initial.items).toHaveLength(50);
    expect(initial.items[0]?.sequence).toBe(101);
    expect(initial.nextBefore).toBe(52);

    const capped = await store.list({ limit: 101 });
    expect(capped.items).toHaveLength(100);
    expect(capped.nextBefore).toBe(2);
    const last = await store.list({ before: capped.nextBefore!, limit: 0 });
    expect(last.items.map(({ sequence }) => sequence)).toEqual([1]);
    expect(last.nextBefore).toBeNull();
    await expect(store.list({ before: 1 })).resolves.toEqual({ items: [], nextBefore: null });
  });
});
