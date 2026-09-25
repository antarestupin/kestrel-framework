import type {
  EmailAddress,
  EmailMessage,
  EmailReceipt,
} from "./types.js";

/** Complete sensitive message retained by a development capture store. */
export interface EmailCapture {
  readonly sequence: number;
  readonly id: string;
  readonly observationId: string;
  readonly capturedAt: Date;
  readonly message: EmailMessage;
}

/** Lightweight inbox row that never carries bodies, headers or attachment data. */
export interface EmailCaptureSummary {
  readonly sequence: number;
  readonly id: string;
  readonly observationId: string;
  readonly capturedAt: Date;
  readonly from: EmailAddress;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly subject: string;
  readonly hasText: boolean;
  readonly hasHtml: boolean;
  readonly attachmentCount: number;
  readonly attachmentBytes: number;
}

export interface EmailCapturePageOptions {
  readonly before?: number;
  readonly limit?: number;
}

export interface EmailCapturePage {
  readonly items: readonly EmailCaptureSummary[];
  readonly nextBefore: number | null;
}

export interface NewEmailCapture {
  readonly id: string;
  readonly observationId: string;
  readonly capturedAt: Date;
  readonly message: EmailMessage;
}

/** Storage contract shared by process-local and persistent capture adapters. */
export interface EmailCaptureStore {
  /** Optional lifecycle preparation used by persistent stores. */
  prepare?(retentionDays: number): Promise<void>;
  capture(capture: NewEmailCapture): Promise<void>;
  clear(): Promise<void>;
  get(id: string): Promise<EmailCapture | undefined>;
  list(options?: EmailCapturePageOptions): Promise<EmailCapturePage>;
}

export interface EmailCaptureResendResult {
  readonly receipt: EmailReceipt;
}

/** Read and control contract consumed by the development Studio extension. */
export interface EmailCaptureInboxSource extends EmailCaptureStore {
  resend(id: string): Promise<EmailCaptureResendResult>;
}

export class EmailCaptureNotFoundError extends Error {
  public readonly name = "EmailCaptureNotFoundError";

  public constructor(public readonly captureId: string) {
    super(`Email capture "${captureId}" does not exist.`);
  }
}

/** Adds safe replay behavior without coupling stores to an email client. */
export class EmailCaptureInbox implements EmailCaptureInboxSource {
  public constructor(
    private readonly store: EmailCaptureStore,
    private readonly send: (message: EmailMessage) => Promise<EmailReceipt>,
  ) {}

  public capture(capture: NewEmailCapture): Promise<void> {
    return this.store.capture(capture);
  }

  public clear(): Promise<void> {
    return this.store.clear();
  }

  public get(id: string): Promise<EmailCapture | undefined> {
    return this.store.get(id);
  }

  public list(options: EmailCapturePageOptions = {}): Promise<EmailCapturePage> {
    return this.store.list(options);
  }

  public async resend(id: string): Promise<EmailCaptureResendResult> {
    const capture = await this.store.get(id);

    if (capture === undefined) {
      throw new EmailCaptureNotFoundError(id);
    }

    return { receipt: await this.send(capture.message) };
  }
}

/** Computes storage metadata without retaining attachment contents in list rows. */
export function summarizeEmailCapture(capture: EmailCapture): EmailCaptureSummary {
  return {
    sequence: capture.sequence,
    id: capture.id,
    observationId: capture.observationId,
    capturedAt: new Date(capture.capturedAt),
    from: { ...capture.message.from },
    to: capture.message.to.map((address) => ({ ...address })),
    cc: capture.message.cc.map((address) => ({ ...address })),
    bcc: capture.message.bcc.map((address) => ({ ...address })),
    subject: capture.message.subject,
    hasText: capture.message.text !== undefined,
    hasHtml: capture.message.html !== undefined,
    attachmentCount: capture.message.attachments.length,
    attachmentBytes: capture.message.attachments.reduce(
      (total, attachment) => total + contentBytes(attachment.content),
      0,
    ),
  };
}

export function contentBytes(content: string | Uint8Array): number {
  return typeof content === "string"
    ? Buffer.byteLength(content, "utf8")
    : content.byteLength;
}
