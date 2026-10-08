import { uuidV7 } from "../../../utils/uuid.js";
import { contentBytes, type EmailCaptureStorageAdapter } from "../../capture.js";
import { EmailDriverError } from "../../errors.js";
import type {
  EmailTransportAdapter,
  EmailDriverContext,
  EmailMessage,
  EmailReceipt,
} from "../../types.js";

const defaultMaximumMessageBytes = 10 * 1_024 * 1_024;

export interface EmailCaptureAdapterOptions {
  readonly store: EmailCaptureStorageAdapter;
  readonly name?: string;
  readonly createCaptureId?: () => string;
  readonly maxMessageBytes?: number;
  readonly now?: () => Date;
}

/** Development transport that captures messages without contacting recipients. */
export class EmailCaptureAdapter implements EmailTransportAdapter {
  public readonly name: string;

  private readonly createCaptureId: () => string;

  private readonly maxMessageBytes: number;

  private readonly now: () => Date;

  public constructor(private readonly options: EmailCaptureAdapterOptions) {
    this.name = options.name ?? "capture";
    this.createCaptureId = options.createCaptureId ?? uuidV7;
    this.maxMessageBytes = options.maxMessageBytes ?? defaultMaximumMessageBytes;
    this.now = options.now ?? (() => new Date());

    if (!Number.isInteger(this.maxMessageBytes) || this.maxMessageBytes <= 0) {
      throw new TypeError("Email capture maxMessageBytes must be a positive integer.");
    }
  }

  public async send(
    message: EmailMessage,
    context: EmailDriverContext,
  ): Promise<EmailReceipt> {
    if (messageBytes(message) > this.maxMessageBytes) {
      throw new EmailDriverError(
        "invalid-message",
        "The email exceeds the local capture size limit.",
      );
    }

    const captureId = this.createCaptureId();
    const capturedAt = new Date(this.now());

    await this.options.store.capture({
      id: captureId,
      observationId: context.observationId,
      capturedAt,
      message,
    });

    return {
      status: "accepted",
      messageId: captureId,
      acceptedAt: capturedAt,
      captureId,
    };
  }
}

function messageBytes(message: EmailMessage): number {
  const structured = JSON.stringify({
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    replyTo: message.replyTo,
    subject: message.subject,
    headers: message.headers,
    attachments: message.attachments.map(({ content: _content, ...metadata }) =>
      metadata),
  });

  return Buffer.byteLength(structured, "utf8")
    + (message.text === undefined ? 0 : Buffer.byteLength(message.text, "utf8"))
    + (message.html === undefined ? 0 : Buffer.byteLength(message.html, "utf8"))
    + message.attachments.reduce(
      (total, attachment) => total + contentBytes(attachment.content),
      0,
    );
}
