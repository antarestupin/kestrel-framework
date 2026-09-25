import { createUuid } from "../../../utils/uuid.js";
import type {
  EmailDriver,
  EmailMessage,
  EmailReceipt,
} from "../../types.js";

export interface MemoryEmailAdapterOptions {
  readonly name?: string;
  readonly createMessageId?: () => string;
  readonly now?: () => Date;
}

/** Process-local transport that captures detached messages for tests and development. */
export class MemoryEmailAdapter implements EmailDriver {
  public readonly name: string;

  private readonly messages: EmailMessage[] = [];

  private readonly createMessageId: () => string;

  private readonly now: () => Date;

  public constructor(options: MemoryEmailAdapterOptions = {}) {
    this.name = options.name ?? "memory";
    this.createMessageId = options.createMessageId ?? createUuid;
    this.now = options.now ?? (() => new Date());
  }

  public async send(message: EmailMessage): Promise<EmailReceipt> {
    this.messages.push(cloneMessage(message));

    return {
      status: "accepted",
      messageId: this.createMessageId(),
      acceptedAt: new Date(this.now()),
    };
  }

  /** Returns snapshots so test assertions cannot mutate the captured inbox. */
  public getMessages(): readonly EmailMessage[] {
    return this.messages.map(cloneMessage);
  }

  public clear(): void {
    this.messages.length = 0;
  }
}

function cloneMessage(message: EmailMessage): EmailMessage {
  const cloneAddresses = (addresses: EmailMessage["to"]) =>
    addresses.map((address) => ({ ...address }));

  return {
    from: { ...message.from },
    to: cloneAddresses(message.to),
    cc: cloneAddresses(message.cc),
    bcc: cloneAddresses(message.bcc),
    replyTo: cloneAddresses(message.replyTo),
    subject: message.subject,
    ...(message.text === undefined ? {} : { text: message.text }),
    ...(message.html === undefined ? {} : { html: message.html }),
    ...(message.headers === undefined
      ? {}
      : { headers: { ...message.headers } }),
    attachments: message.attachments.map((attachment) => ({
      ...attachment,
      content: typeof attachment.content === "string"
        ? attachment.content
        : new Uint8Array(attachment.content),
    })),
  };
}
