import { uuidV7 } from "../utils/uuid.js";
import {
  EmailSendError,
  normalizeEmailSendError,
} from "./errors.js";
import { normalizeEmailMessage } from "./message.js";
import type { EmailInstrumentationEvent } from "./observations.js";
import type {
  EmailClientOptions,
  EmailMessage,
  EmailMessageInput,
  EmailReceipt,
  EmailSendOptions,
} from "./types.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Provider-neutral transactional email facade. */
export class EmailClient {
  private readonly name: string;

  private readonly monotonicNow: () => number;

  private readonly createObservationId: () => string;

  private closed = false;

  public constructor(private readonly options: EmailClientOptions) {
    this.name = normalizeIdentifier(options.name, "client name");
    normalizeIdentifier(options.driver.name, "driver name");
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.createObservationId = options.createObservationId ?? uuidV7;
  }

  /** Validates and hands one message to the configured transport. */
  public async send(
    input: EmailMessageInput,
    options: EmailSendOptions = {},
  ): Promise<EmailReceipt> {
    const operation = normalizeIdentifier(
      options.operation ?? `${this.name}.send`,
      "operation",
    );
    const startedAt = this.measureTime();
    const observationId = this.createObservationId();
    let message: EmailMessage | undefined;

    try {
      if (this.closed) {
        throw new EmailSendError(
          operation,
          "unavailable",
          false,
          undefined,
        );
      }

      try {
        message = normalizeEmailMessage(input);
      } catch (error: unknown) {
        throw new EmailSendError(
          operation,
          "invalid-message",
          false,
          undefined,
          { cause: error },
        );
      }

      const receipt = normalizeReceipt(await this.options.driver.send(message, {
        observationId,
      }));

      this.record({
        observationId,
        durationMs: duration(startedAt, this.measureTime()),
        outcome: "success",
        data: this.createObservationData(
          message,
          operation,
          "accepted",
          receipt.captureId,
        ),
      });

      return receipt;
    } catch (error: unknown) {
      const normalizedError = normalizeEmailSendError(operation, error);

      this.record({
        observationId,
        durationMs: duration(startedAt, this.measureTime()),
        outcome: "failure",
        data: this.createObservationData(
          message,
          operation,
          normalizedError.code,
        ),
      });

      throw normalizedError;
    }
  }

  /** Releases transport resources such as SMTP connection pools. */
  public async close(): Promise<void> {
    if (this.closed) return;

    this.closed = true;
    await this.options.driver.close?.();
  }

  private createObservationData(
    message: EmailMessage | undefined,
    operation: string,
    result: EmailInstrumentationEvent["data"]["result"],
    captureId?: string,
  ): EmailInstrumentationEvent["data"] {
    return {
      client: this.name,
      operation,
      transport: this.options.driver.name,
      result,
      recipientCount: message === undefined
        ? 0
        : message.to.length + message.cc.length + message.bcc.length,
      attachmentCount: message?.attachments.length ?? 0,
      ...(captureId === undefined ? {} : { captureId }),
    };
  }

  private measureTime(): number {
    const value = this.monotonicNow();

    return Number.isFinite(value) ? value : 0;
  }

  private record(event: EmailInstrumentationEvent): void {
    try {
      this.options.instrumentation?.record(event);
    } catch {
      // Diagnostics must never change email delivery semantics.
    }
  }
}

function normalizeReceipt(receipt: EmailReceipt): EmailReceipt {
  if (receipt === null || typeof receipt !== "object" || receipt.status !== "accepted") {
    throw new TypeError("An email driver returned an invalid receipt.");
  }

  if (receipt.messageId !== undefined && typeof receipt.messageId !== "string") {
    throw new TypeError("An email driver returned an invalid message identifier.");
  }
  if (receipt.captureId !== undefined && typeof receipt.captureId !== "string") {
    throw new TypeError("An email driver returned an invalid capture identifier.");
  }
  if (
    receipt.acceptedAt !== undefined
    && (!(receipt.acceptedAt instanceof Date)
      || !Number.isFinite(receipt.acceptedAt.getTime()))
  ) {
    throw new TypeError("An email driver returned an invalid acceptance date.");
  }

  return Object.freeze({
    status: "accepted",
    ...(receipt.messageId === undefined
      ? {}
      : { messageId: receipt.messageId }),
    ...(receipt.acceptedAt === undefined
      ? {}
      : { acceptedAt: new Date(receipt.acceptedAt) }),
    ...(receipt.captureId === undefined
      ? {}
      : { captureId: receipt.captureId }),
  });
}

function normalizeIdentifier(value: string, field: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new TypeError(`Email ${field} must be a stable identifier.`);
  }

  return value;
}

function duration(startedAt: number, completedAt: number): number {
  return Math.max(0, completedAt - startedAt);
}
