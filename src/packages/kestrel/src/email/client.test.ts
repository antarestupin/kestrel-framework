import { describe, expect, it, vi } from "vitest";

import { EmailClient } from "./client.js";
import { EmailDriverError, EmailSendError } from "./errors.js";
import type { EmailInstrumentationEvent } from "./observations.js";
import type { EmailTransportAdapter, EmailMessage } from "./types.js";

describe("EmailClient", () => {
  it("normalizes and detaches messages before invoking the driver", async () => {
    let received: EmailMessage | undefined;
    const driver: EmailTransportAdapter = {
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
    const driver: EmailTransportAdapter = {
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
    const driver: EmailTransportAdapter = {
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

it.each([1, 2])("keeps delivery successful when the diagnostic clock throws on reading %s", async (throwOn) => {
  const send = vi.fn(async () => ({ status: "accepted" as const, messageId: "provider-1" }));
  const record = vi.fn();
  let reads = 0;
  const client = new EmailClient({
    name: "transactional",
    driver: { name: "controlled", send },
    instrumentation: { record },
    monotonicNow: () => {
      if (++reads === throwOn) throw new Error("diagnostic clock unavailable");
      return NaN;
    },
  });
  const message = { from: "sender@example.com", to: "reader@example.com", subject: "Welcome", text: "Hello" };

  // A failure after the handoff must not encourage duplicate delivery through retry.
  await expect(client.send(message)).resolves.toEqual({ status: "accepted", messageId: "provider-1" });
  expect(send).toHaveBeenCalledOnce();
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 0, outcome: "success" }));
});

it.each([
  [null, "receipt"],
  ["accepted", "receipt"],
  [{ status: "rejected" }, "receipt"],
  [Object.assign(() => undefined, { status: "accepted" }), "receipt"],
  [{ status: "accepted", messageId: 42 }, "message identifier"],
  [{ status: "accepted", captureId: 42 }, "capture identifier"],
  [{ status: "accepted", acceptedAt: "2026-01-01" }, "acceptance date"],
  [{ status: "accepted", acceptedAt: new Date(NaN) }, "acceptance date"],
])("does not report success for malformed driver receipt %j", async (receipt, detail) => {
  const client = new EmailClient({
    name: "transactional", driver: { name: "controlled", send: async () => receipt as never },
  });
  await expect(client.send(message)).rejects.toMatchObject({
    name: "EmailSendError",
    message: 'Email operation "transactional.send" failed (transport).',
    operation: "transactional.send", code: "transport", retryable: false,
    cause: new TypeError(`An email driver returned an invalid ${detail}.`),
  });
});

it("rejects an invalid logical operation before handing the message to its driver", async () => {
  const send = vi.fn();
  const client = new EmailClient({ name: "transactional", driver: { name: "controlled", send } });
  await expect(client.send(message, { operation: "unexpected operation" }))
    .rejects.toThrow("Email operation must be a stable identifier.");
  expect(send).not.toHaveBeenCalled();
});

const message = {
  from: "sender@example.com", to: "reader@example.com", subject: "Welcome", text: "Hello",
};

it("identifies malformed client and driver names at construction", () => {
  const send = vi.fn();
  expect(() => new EmailClient({ name: 42 as never, driver: { name: "transport", send } }))
    .toThrow("Email client name must be a stable identifier.");
  expect(() => new EmailClient({ name: "transactional", driver: { name: "bad name", send } }))
    .toThrow("Email driver name must be a stable identifier.");
});

it("records elapsed time and associates a captured message with its observation", async () => {
  const clock = vi.spyOn(performance, "now");
  const record = vi.fn();
  const send = vi.fn().mockResolvedValueOnce({ status: "accepted", captureId: "capture-1" })
    .mockResolvedValueOnce({ status: "accepted" });
  const client = new EmailClient({ name: "transactional", driver: { name: "transport", send }, instrumentation: { record } });

  try {
    clock.mockReturnValueOnce(10).mockReturnValueOnce(14).mockReturnValueOnce(20).mockReturnValueOnce(21);
    await expect(client.send({ ...message, cc: "copy@example.com" }))
      .resolves.toStrictEqual({ status: "accepted", captureId: "capture-1" });
    await expect(client.send(message)).resolves.toStrictEqual({ status: "accepted" });
    expect(record.mock.calls.map(([event]) => event)).toStrictEqual([
      {
        observationId: expect.any(String), durationMs: 4, outcome: "success",
        data: { client: "transactional", operation: "transactional.send", transport: "transport", result: "accepted",
          recipientCount: 2, attachmentCount: 0, captureId: "capture-1" },
      },
      {
        observationId: expect.any(String), durationMs: 1, outcome: "success",
        data: { client: "transactional", operation: "transactional.send", transport: "transport", result: "accepted",
          recipientCount: 1, attachmentCount: 0 },
      },
    ]);
  } finally {
    clock.mockRestore();
    await client.close();
  }
});

it("preserves the original invalid input and transport errors as causes", async () => {
  const driverError = new EmailDriverError("unsupported", "driver detail");
  const networkError = new Error("socket detail");
  const send = vi.fn().mockRejectedValueOnce(driverError).mockRejectedValueOnce(networkError);
  const client = new EmailClient({ name: "transactional", driver: { name: "transport", send } });

  await expect(client.send({ ...message, subject: "" })).rejects.toMatchObject({
    code: "invalid-message", retryable: false, cause: expect.any(TypeError),
  });
  await expect(client.send(message)).rejects.toMatchObject({ code: "unsupported", retryable: false, cause: driverError });
  await expect(client.send(message)).rejects.toMatchObject({ code: "transport", retryable: false, cause: networkError });
  expect(driverError.name).toBe("EmailDriverError");
  await client.close();
});

it("shares the pending driver shutdown and its failure with every caller", async () => {
  const driverShutdown = Promise.withResolvers<void>();
  const failure = new Error("driver shutdown failed");
  const close = vi.fn(() => driverShutdown.promise);
  const client = new EmailClient({ name: "transactional", driver: {
    name: "external", send: vi.fn(), close,
  } });

  const first = client.close();
  const second = client.close();
  // Start the rejection checks before settling the driver's shared shutdown.
  const outcome = Promise.all([expect(first).rejects.toBe(failure), expect(second).rejects.toBe(failure)]);
  driverShutdown.reject(failure);
  await outcome;
  await expect(client.close()).rejects.toBe(failure);
  await expect(client.send(message)).rejects.toMatchObject({ code: "unavailable" });
  expect(close).toHaveBeenCalledOnce();
});

it("leaves a borrowed driver open while rejecting future sends through the closed client", async () => {
  const close = vi.fn();
  const send = vi.fn();
  const client = new EmailClient({ name: "transactional", closeDriver: false, driver: { name: "external", send, close } });

  await client.close();
  await expect(client.send(message)).rejects.toMatchObject({
    name: "EmailSendError", code: "unavailable", retryable: false, statusCode: undefined,
  });
  expect(close).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
