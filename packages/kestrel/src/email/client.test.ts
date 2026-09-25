import { describe, expect, it, vi } from "vitest";

import { EmailClient } from "./client.js";
import { EmailDriverError, EmailSendError } from "./errors.js";
import type { EmailInstrumentationEvent } from "./observations.js";
import type { EmailDriver, EmailMessage } from "./types.js";

describe("EmailClient", () => {
  it("normalizes and detaches messages before invoking the driver", async () => {
    let received: EmailMessage | undefined;
    const driver: EmailDriver = {
      name: "test",
      send: vi.fn(async (message) => {
        received = message;

        return {
          status: "accepted" as const,
          messageId: "message-1",
          acceptedAt: new Date("2026-08-23T10:00:00.000Z"),
        };
      }),
    };
    const attachment = new Uint8Array([1, 2, 3]);
    const headers = { "X-Correlation": "correlation-1" };
    const input = {
      from: { address: "sender@example.com", name: "Sender" },
      to: "member@example.com",
      cc: [{ address: "copy@example.com" }],
      subject: "Welcome",
      text: "Welcome to the application.",
      headers,
      attachments: [{
        filename: "guide.pdf",
        content: attachment,
        contentType: "application/pdf",
      }],
    };
    const client = new EmailClient({ name: "transactional", driver });

    const receipt = await client.send(input, { operation: "member.welcome" });
    attachment[0] = 9;
    headers["X-Correlation"] = "changed";

    expect(receipt).toEqual({
      status: "accepted",
      messageId: "message-1",
      acceptedAt: new Date("2026-08-23T10:00:00.000Z"),
    });
    expect(received).toMatchObject({
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "member@example.com" }],
      cc: [{ address: "copy@example.com" }],
      bcc: [],
      replyTo: [],
      headers: { "X-Correlation": "correlation-1" },
    });
    expect(received?.attachments[0]?.content).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("records non-sensitive metadata for accepted and rejected sends", async () => {
    const events: EmailInstrumentationEvent[] = [];
    const driver: EmailDriver = {
      name: "smtp",
      send: vi.fn()
        .mockResolvedValueOnce({ status: "accepted", messageId: "message-1" })
        .mockRejectedValueOnce(new EmailDriverError(
          "rate-limited",
          "Sensitive provider response",
          { retryable: true, statusCode: 429 },
        )),
    };
    let now = 10;
    const observationIds = ["observation-1", "observation-2"];
    const client = new EmailClient({
      name: "transactional",
      driver,
      instrumentation: { record: (event) => events.push(event) },
      monotonicNow: () => now += 5,
      createObservationId: () => observationIds.shift()!,
    });
    const message = {
      from: "secret-sender@example.com",
      to: ["secret-first@example.com", "secret-second@example.com"],
      bcc: "secret-copy@example.com",
      subject: "Sensitive subject",
      html: "<p>Sensitive body</p>",
      attachments: [{ filename: "sensitive-name.txt", content: "secret" }],
    };

    await client.send(message, { operation: "member.welcome" });
    await expect(client.send(message, { operation: "member.retry" }))
      .rejects.toMatchObject({
        code: "rate-limited",
        retryable: true,
        statusCode: 429,
      } satisfies Partial<EmailSendError>);

    expect(events).toEqual([
      {
        observationId: "observation-1",
        durationMs: 5,
        outcome: "success",
        data: {
          client: "transactional",
          operation: "member.welcome",
          transport: "smtp",
          result: "accepted",
          recipientCount: 3,
          attachmentCount: 1,
        },
      },
      {
        observationId: "observation-2",
        durationMs: 5,
        outcome: "failure",
        data: {
          client: "transactional",
          operation: "member.retry",
          transport: "smtp",
          result: "rate-limited",
          recipientCount: 3,
          attachmentCount: 1,
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("Sensitive");
  });

  it("normalizes validation and unknown driver failures", async () => {
    const driver: EmailDriver = {
      name: "test",
      send: vi.fn(async () => {
        throw new Error("implementation detail");
      }),
    };
    const client = new EmailClient({ name: "transactional", driver });

    await expect(client.send({
      from: "sender@example.com",
      to: "invalid address",
      subject: "Welcome",
      text: "Hello",
    })).rejects.toMatchObject({
      code: "invalid-message",
      operation: "transactional.send",
    } satisfies Partial<EmailSendError>);
    expect(driver.send).not.toHaveBeenCalled();

    await expect(client.send({
      from: "sender@example.com",
      to: "member@example.com",
      subject: "Welcome",
      text: "Hello",
    })).rejects.toMatchObject({
      code: "transport",
      operation: "transactional.send",
    } satisfies Partial<EmailSendError>);
  });

  it("does not let instrumentation failures affect sends", async () => {
    const client = new EmailClient({
      name: "transactional",
      driver: {
        name: "test",
        send: async () => ({ status: "accepted" }),
      },
      instrumentation: {
        record: () => {
          throw new Error("diagnostic failure");
        },
      },
    });

    await expect(client.send({
      from: "sender@example.com",
      to: "member@example.com",
      subject: "Welcome",
      text: "Hello",
    })).resolves.toEqual({ status: "accepted" });
  });

  it("closes its driver once and rejects subsequent sends", async () => {
    const close = vi.fn(async () => undefined);
    const client = new EmailClient({
      name: "transactional",
      driver: {
        name: "test",
        send: async () => ({ status: "accepted" }),
        close,
      },
    });

    await client.close();
    await client.close();

    expect(close).toHaveBeenCalledOnce();
    await expect(client.send({
      from: "sender@example.com",
      to: "member@example.com",
      subject: "Welcome",
      text: "Hello",
    })).rejects.toMatchObject({ code: "unavailable" });
  });
});
