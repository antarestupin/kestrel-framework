import type { EmailInstrumentation } from "./observations.js";

/** A mailbox and its optional human-readable display name. */
export interface EmailAddress {
  readonly address: string;
  readonly name?: string;
}

/** Convenient address input normalized before a driver receives it. */
export type EmailAddressInput = string | EmailAddress;

/** Attachment content shared by transport adapters. */
export interface EmailAttachment {
  readonly filename: string;
  /** Strings represent UTF-8 text while byte arrays represent binary content. */
  readonly content: string | Uint8Array;
  readonly contentType?: string;
  readonly disposition?: "attachment" | "inline";
  /** Identifier referenced by an inline `cid:` URL in the HTML body. */
  readonly contentId?: string;
}

/** Caller-facing message shape accepted by the email client. */
export interface EmailMessageInput {
  readonly from: EmailAddressInput;
  readonly to: EmailAddressInput | readonly EmailAddressInput[];
  readonly cc?: EmailAddressInput | readonly EmailAddressInput[];
  readonly bcc?: EmailAddressInput | readonly EmailAddressInput[];
  readonly replyTo?: EmailAddressInput | readonly EmailAddressInput[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: readonly EmailAttachment[];
}

/** Validated, detached message snapshot received by every driver. */
export interface EmailMessage {
  readonly from: EmailAddress;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly replyTo: readonly EmailAddress[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments: readonly EmailAttachment[];
}

/** Successful handoff to a transport, which does not imply final delivery. */
export interface EmailReceipt {
  readonly status: "accepted";
  readonly messageId?: string;
  readonly acceptedAt?: Date;
  /** Local capture identity, when the configured driver stores an inbox entry. */
  readonly captureId?: string;
}

/** Metadata controlling one logical send without becoming email content. */
export interface EmailSendOptions {
  /** Stable, non-sensitive identity used by observations and diagnostics. */
  readonly operation?: string;
}

/** Storage- and provider-neutral contract implemented by transport adapters. */
export interface EmailDriver {
  readonly name: string;
  send(message: EmailMessage, context: EmailDriverContext): Promise<EmailReceipt>;
  close?(): Promise<void>;
}

/** Metadata reserved before invoking a driver for cross-store correlation. */
export interface EmailDriverContext {
  readonly observationId: string;
}

export interface EmailClientOptions {
  /** Stable client identity used to group observations. */
  readonly name: string;
  readonly driver: EmailDriver;
  readonly instrumentation?: EmailInstrumentation;
  readonly monotonicNow?: () => number;
  readonly createObservationId?: () => string;
}
