import {
  EmailAdapterError as SdkAdapterError,
  type EmailAdapter as SdkAdapter,
  type EmailMessage as SdkMessage,
} from "@opencoredev/email-sdk";
import { describe, expect, it, vi } from "vitest";

import { EmailClient } from "../../client.js";
import type { EmailSendError } from "../../errors.js";
import { EmailSdkEmailAdapter } from "./adapter.js";

const capabilities = {
  repeatedHeaders: false,
  idempotency: "none" as const,
  scheduling: false,
  personalized: "unsupported" as const,
};

describe("EmailSdkEmailAdapter", () => {
  it("maps the Kestrel message and receipt without exposing raw data", async () => {
    let received: SdkMessage | undefined;
    const adapter: SdkAdapter = {
      name: "smtp",
      capabilities,
      send: vi.fn(async (message) => {
        received = message;

        return {
          adapter: "smtp",
          id: "provider-message-1",
          accepted: ["first@example.com", "second@example.com"],
          rejected: [],
          raw: { sensitive: "provider detail" },
        };
      }),
    };
    const client = new EmailClient({
      name: "transactional",
      driver: new EmailSdkEmailAdapter({ adapter }),
    });

    const receipt = await client.send({
      from: { address: "sender@example.com", name: "Sender" },
      to: ["first@example.com", "second@example.com"],
      replyTo: "reply@example.com",
      subject: "Welcome",
      text: "Hello",
      html: "<p>Hello</p>",
      headers: { "X-Correlation": "correlation-1" },
      attachments: [{
        filename: "logo.png",
        content: new Uint8Array([1, 2]),
        contentType: "image/png",
        disposition: "inline",
        contentId: "logo",
      }],
    });

    expect(receipt).toEqual({
      status: "accepted",
      messageId: "provider-message-1",
    });
    expect(received).toMatchObject({
      from: { email: "sender@example.com", name: "Sender" },
      to: [{ email: "first@example.com" }, { email: "second@example.com" }],
      replyTo: [{ email: "reply@example.com" }],
      headers: [{ name: "X-Correlation", value: "correlation-1" }],
      attachments: [{
        filename: "logo.png",
        contentType: "image/png",
        disposition: "inline",
        contentId: "logo",
      }],
    });
    expect(receipt).not.toHaveProperty("raw");
  });

  it("maps Email SDK failures into the Kestrel taxonomy", async () => {
    const adapter: SdkAdapter = {
      name: "ses",
      capabilities,
      send: async () => {
        throw new SdkAdapterError("Provider quota exceeded", {
          adapter: "ses",
          status: 429,
          retryable: true,
          delivery: "not_sent",
        });
      },
    };
    const client = new EmailClient({
      name: "transactional",
      driver: new EmailSdkEmailAdapter({ adapter }),
    });

    await expect(client.send({
      from: "sender@example.com",
      to: "member@example.com",
      subject: "Welcome",
      text: "Hello",
    })).rejects.toMatchObject({
      code: "rate-limited",
      statusCode: 429,
      retryable: true,
    } satisfies Partial<EmailSendError>);
  });

  it("rejects partial recipient acceptance instead of hiding it", async () => {
    const adapter: SdkAdapter = {
      name: "smtp",
      capabilities,
      send: async () => ({
        adapter: "smtp",
        accepted: ["first@example.com"],
        rejected: ["second@example.com"],
      }),
    };
    const client = new EmailClient({
      name: "transactional",
      driver: new EmailSdkEmailAdapter({ adapter }),
    });

    await expect(client.send({
      from: "sender@example.com",
      to: ["first@example.com", "second@example.com"],
      subject: "Welcome",
      text: "Hello",
    })).rejects.toMatchObject({ code: "provider" });
  });
});
