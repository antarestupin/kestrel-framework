import {
  asc,
  desc,
  eq,
  lt,
} from "drizzle-orm";
import {
  drizzle,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  contentBytes,
  type EmailCapture,
  type EmailCapturePage,
  type EmailCapturePageOptions,
  type EmailCaptureStore,
  type EmailCaptureSummary,
  type NewEmailCapture,
} from "../../capture.js";
import { normalizeEmailMessage } from "../../message.js";
import {
  emailCaptureAttachments,
  emailCaptures,
  type StoredEmailCapture,
  type StoredEmailCaptureAttachment,
} from "./schema.js";

const defaultPageSize = 50;
const maximumPageSize = 100;

type CaptureDatabase = NodePgDatabase<{
  emailCaptureAttachments: typeof emailCaptureAttachments;
  emailCaptures: typeof emailCaptures;
}>;

/** Persistent development inbox shared by every local application process. */
export class PostgresEmailCaptureStore implements EmailCaptureStore {
  private readonly database: CaptureDatabase;

  public constructor(private readonly pool: Pool) {
    this.database = drizzle(pool, {
      schema: { emailCaptureAttachments, emailCaptures },
    });
  }

  /** Verifies local tables and removes captures outside their retention window. */
  public async prepare(retentionDays: number): Promise<void> {
    if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
      throw new TypeError("Email capture retentionDays must be a positive integer.");
    }

    await this.pool.query("select 1 from dev.email_capture limit 1");
    await this.pool.query(
      `with expired as materialized (
        select id from dev.email_capture
        where captured_at < now() - ($1 * interval '1 day')
      ), deleted_attachments as (
        delete from dev.email_capture_attachment
        where capture_id in (select id from expired)
      )
      delete from dev.email_capture
      where id in (select id from expired)`,
      [retentionDays],
    );
  }

  public async capture(capture: NewEmailCapture): Promise<void> {
    const attachmentBytes = capture.message.attachments.reduce(
      (total, attachment) => total + contentBytes(attachment.content),
      0,
    );

    await this.database.transaction(async (transaction) => {
      await transaction.insert(emailCaptures).values({
        id: capture.id,
        observationId: capture.observationId,
        capturedAt: capture.capturedAt,
        sender: capture.message.from,
        recipientsTo: capture.message.to,
        recipientsCc: capture.message.cc,
        recipientsBcc: capture.message.bcc,
        replyTo: capture.message.replyTo,
        subject: capture.message.subject,
        ...(capture.message.text === undefined
          ? {}
          : { textBody: capture.message.text }),
        ...(capture.message.html === undefined
          ? {}
          : { htmlBody: capture.message.html }),
        ...(capture.message.headers === undefined
          ? {}
          : { headers: capture.message.headers }),
        attachmentCount: capture.message.attachments.length,
        attachmentBytes,
      });

      if (capture.message.attachments.length > 0) {
        await transaction.insert(emailCaptureAttachments).values(
          capture.message.attachments.map((attachment, position) => ({
            captureId: capture.id,
            position,
            filename: attachment.filename,
            content: Buffer.from(attachment.content),
            contentEncoding: typeof attachment.content === "string"
              ? "text" as const
              : "binary" as const,
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
        );
      }
    });
  }

  public async clear(): Promise<void> {
    await this.database.transaction(async (transaction) => {
      // Attachment cleanup precedes captures because this disposable schema
      // deliberately avoids a Drizzle Push ordering-sensitive foreign key.
      await transaction.delete(emailCaptureAttachments);
      await transaction.delete(emailCaptures);
    });
  }

  public async get(id: string): Promise<EmailCapture | undefined> {
    const [capture] = await this.database
      .select()
      .from(emailCaptures)
      .where(eq(emailCaptures.id, id))
      .limit(1);

    if (capture === undefined) {
      return undefined;
    }

    const attachments = await this.database
      .select()
      .from(emailCaptureAttachments)
      .where(eq(emailCaptureAttachments.captureId, id))
      .orderBy(asc(emailCaptureAttachments.position));

    return hydrateCapture(capture, attachments);
  }

  public async list(
    options: EmailCapturePageOptions = {},
  ): Promise<EmailCapturePage> {
    const limit = Math.min(
      Math.max(options.limit ?? defaultPageSize, 1),
      maximumPageSize,
    );
    const items = await this.database
      .select()
      .from(emailCaptures)
      .where(options.before === undefined
        ? undefined
        : lt(emailCaptures.sequence, options.before))
      .orderBy(desc(emailCaptures.sequence))
      .limit(limit + 1);
    const hasNextPage = items.length > limit;
    const visibleItems = hasNextPage ? items.slice(0, limit) : items;

    return {
      items: visibleItems.map(toSummary),
      nextBefore: hasNextPage
        ? (visibleItems.at(-1)?.sequence ?? null)
        : null,
    };
  }
}

function hydrateCapture(
  capture: StoredEmailCapture,
  attachments: readonly StoredEmailCaptureAttachment[],
): EmailCapture {
  return {
    sequence: capture.sequence,
    id: capture.id,
    observationId: capture.observationId,
    capturedAt: new Date(capture.capturedAt),
    message: normalizeEmailMessage({
      from: capture.sender,
      to: capture.recipientsTo,
      cc: capture.recipientsCc,
      bcc: capture.recipientsBcc,
      replyTo: capture.replyTo,
      subject: capture.subject,
      ...(capture.textBody === null ? {} : { text: capture.textBody }),
      ...(capture.htmlBody === null ? {} : { html: capture.htmlBody }),
      ...(capture.headers === null ? {} : { headers: capture.headers }),
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.contentEncoding === "text"
          ? attachment.content.toString("utf8")
          : new Uint8Array(attachment.content),
        ...(attachment.contentType === null
          ? {}
          : { contentType: attachment.contentType }),
        ...(attachment.disposition === null
          ? {}
          : { disposition: attachment.disposition }),
        ...(attachment.contentId === null
          ? {}
          : { contentId: attachment.contentId }),
      })),
    }),
  };
}

function toSummary(capture: StoredEmailCapture): EmailCaptureSummary {
  return {
    sequence: capture.sequence,
    id: capture.id,
    observationId: capture.observationId,
    capturedAt: new Date(capture.capturedAt),
    from: { ...capture.sender },
    to: capture.recipientsTo.map((address) => ({ ...address })),
    cc: capture.recipientsCc.map((address) => ({ ...address })),
    bcc: capture.recipientsBcc.map((address) => ({ ...address })),
    subject: capture.subject,
    hasText: capture.textBody !== null,
    hasHtml: capture.htmlBody !== null,
    attachmentCount: capture.attachmentCount,
    attachmentBytes: capture.attachmentBytes,
  };
}
