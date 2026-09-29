import {
  createEmailClient,
  EmailAbortError as SdkAbortError,
  EmailAdapterError as SdkAdapterError,
  EmailAllRecipientsFailedError as SdkAllRecipientsFailedError,
  EmailRouteError as SdkRouteError,
  EmailValidationError as SdkValidationError,
  type EmailAdapter as SdkAdapter,
  type EmailAddress as SdkAddress,
  type EmailClient as SdkClient,
  type EmailMessage as SdkMessage,
} from "@opencoredev/email-sdk";

import { EmailDriverError } from "../../errors.js";
import type {
  EmailDriver,
  EmailMessage,
  EmailReceipt,
} from "../../types.js";

export interface EmailSdkEmailAdapterOptions {
  readonly adapter: SdkAdapter;
}

/** Bridges the Kestrel contract to Email SDK without leaking its public API. */
export class EmailSdkEmailAdapter implements EmailDriver {
  public readonly name: string;

  private readonly email: SdkClient;

  public constructor(options: EmailSdkEmailAdapterOptions) {
    this.name = options.adapter.name;
    this.email = createEmailClient({
      adapters: [options.adapter],
      // Kestrel owns diagnostics and must not enable external telemetry.
      telemetry: false,
    });
  }

  public async send(message: EmailMessage): Promise<EmailReceipt> {
    try {
      const result = await this.email.send(toSdkMessage(message));

      if ((result.rejected?.length ?? 0) > 0) {
        throw new EmailDriverError(
          "provider",
          "The email transport rejected one or more recipients.",
        );
      }

      return {
        status: "accepted",
        ...(result.id === undefined ? {} : { messageId: result.id }),
      };
    } catch (error: unknown) {
      if (error instanceof EmailDriverError) {
        throw error;
      }

      throw toDriverError(error);
    }
  }
}

function toSdkMessage(message: EmailMessage): SdkMessage {
  const envelope = {
    from: toSdkAddress(message.from),
    to: message.to.map(toSdkAddress),
    ...(message.cc.length === 0
      ? {}
      : { cc: message.cc.map(toSdkAddress) }),
    ...(message.bcc.length === 0
      ? {}
      : { bcc: message.bcc.map(toSdkAddress) }),
    ...(message.replyTo.length === 0
      ? {}
      : { replyTo: message.replyTo.map(toSdkAddress) }),
    subject: message.subject,
    ...(message.headers === undefined
      ? {}
      : {
          headers: Object.entries(message.headers).map(([name, value]) => ({
            name,
            value,
          })),
        }),
    ...(message.attachments.length === 0
      ? {}
      : {
          attachments: message.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: typeof attachment.content === "string"
              ? attachment.content
              : new Uint8Array(attachment.content),
            contentEncoding: "raw" as const,
            ...(attachment.contentType === undefined
              ? {}
              : { contentType: attachment.contentType }),
            ...(attachment.disposition === undefined
              ? {}
              : { disposition: attachment.disposition }),
            ...(attachment.contentId === undefined
              ? {}
              : { contentId: attachment.contentId }),
          })),
        }),
  };

  if (message.html !== undefined) {
    return {
      ...envelope,
      html: message.html,
      ...(message.text === undefined ? {} : { text: message.text }),
    };
  }

  if (message.text === undefined) {
    throw new EmailDriverError(
      "invalid-message",
      "The normalized email message has no body.",
    );
  }

  return { ...envelope, text: message.text };
}

function toSdkAddress(address: EmailMessage["from"]): SdkAddress {
  return {
    email: address.address,
    ...(address.name === undefined ? {} : { name: address.name }),
  };
}

function toDriverError(error: unknown): EmailDriverError {
  if (error instanceof SdkAbortError) {
    return new EmailDriverError("cancelled", "The email send was cancelled.", {
      cause: error,
    });
  }

  if (error instanceof SdkValidationError) {
    return new EmailDriverError(
      "invalid-message",
      "Email SDK rejected the message contract.",
      { cause: error },
    );
  }

  if (
    error instanceof SdkRouteError
    || error instanceof SdkAllRecipientsFailedError
  ) {
    const failure = error.failures.at(-1);

    return failure === undefined
      ? new EmailDriverError("transport", "Email SDK could not route the message.", {
          cause: error,
        })
      : fromSdkAdapterError(failure, error);
  }

  if (error instanceof SdkAdapterError) {
    return fromSdkAdapterError(error, error);
  }

  return new EmailDriverError(
    "transport",
    "Email SDK failed before accepting the message.",
    { cause: error },
  );
}

function fromSdkAdapterError(
  error: SdkAdapterError,
  cause: unknown,
): EmailDriverError {
  return new EmailDriverError(
    codeFromStatus(error.status),
    "The Email SDK transport rejected the message.",
    {
      cause,
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { statusCode: error.status }),
    },
  );
}

function codeFromStatus(status: number | undefined) {
  if (status === 401 || status === 403) return "authentication" as const;
  if (status === 408 || status === 504) return "timeout" as const;
  if (status === 429) return "rate-limited" as const;

  return status === undefined ? "transport" as const : "provider" as const;
}
