import {
  bigint,
  customType,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { defineDatabaseTableDescriptions } from "../../../db/schema_contributions/descriptions.js";
import { devSchema } from "../../../db/dev_schema.js";
import type { EmailAddress } from "../../types.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// Captures are disposable local data and never enter deployed migrations.
export const emailCaptures = devSchema.table(
  "email_capture",
  {
    sequence: bigint("sequence", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    // A column constraint is emitted inside CREATE TABLE, before Drizzle adds
    // the attachment foreign key that references this stable public identity.
    id: uuid("id").notNull().unique("email_capture_id_unique"),
    // The observation is persisted asynchronously, so this is intentionally
    // not a foreign key and may temporarily or permanently remain unresolved.
    observationId: uuid("observation_id").notNull(),
    capturedAt: timestamp("captured_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    sender: jsonb("sender").$type<EmailAddress>().notNull(),
    recipientsTo: jsonb("recipients_to").$type<readonly EmailAddress[]>().notNull(),
    recipientsCc: jsonb("recipients_cc").$type<readonly EmailAddress[]>().notNull(),
    recipientsBcc: jsonb("recipients_bcc").$type<readonly EmailAddress[]>().notNull(),
    replyTo: jsonb("reply_to").$type<readonly EmailAddress[]>().notNull(),
    subject: text("subject").notNull(),
    textBody: text("text_body"),
    htmlBody: text("html_body"),
    headers: jsonb("headers").$type<Readonly<Record<string, string>>>(),
    attachmentCount: integer("attachment_count").notNull(),
    attachmentBytes: bigint("attachment_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("email_capture_observation_id_idx").on(table.observationId),
    index("email_capture_captured_at_idx").on(table.capturedAt),
  ],
);

defineDatabaseTableDescriptions(emailCaptures, {
  description: "Disposable emails captured instead of delivery for local development and Studio inspection.",
  columns: {
    sequence: "Monotonically increasing storage order of the captured email.",
    id: "Globally unique public identifier of the captured email.",
    observationId: "Identifier of the asynchronously persisted observation describing this delivery attempt.",
    capturedAt: "Date and time when the email delivery was intercepted.",
    sender: "Structured sender email address.",
    recipientsTo: "Structured primary recipients from the To field.",
    recipientsCc: "Structured copy recipients from the Cc field.",
    recipientsBcc: "Structured blind-copy recipients from the Bcc field.",
    replyTo: "Structured addresses to which replies should be sent.",
    subject: "Email subject line.",
    textBody: "Optional plain-text email body.",
    htmlBody: "Optional HTML email body.",
    headers: "Optional additional email headers.",
    attachmentCount: "Number of attachments stored for the captured email.",
    attachmentBytes: "Total unencoded size in bytes of all captured attachments.",
    createdAt: "Date and time when the captured email was persisted.",
  },
});

export const emailCaptureAttachments = devSchema.table(
  "email_capture_attachment",
  {
    // The store owns cleanup transactionally. Avoiding a cross-table foreign
    // key also keeps Drizzle Push from emitting it before the referenced
    // development-only uniqueness constraint exists.
    captureId: uuid("capture_id").notNull(),
    position: integer("position").notNull(),
    filename: text("filename").notNull(),
    content: bytea("content").notNull(),
    contentEncoding: text("content_encoding")
      .$type<"binary" | "text">()
      .notNull(),
    contentType: text("content_type"),
    disposition: text("disposition").$type<"attachment" | "inline">(),
    contentId: text("content_id"),
  },
  (table) => [
    primaryKey({ columns: [table.captureId, table.position] }),
    index("email_capture_attachment_capture_id_idx").on(table.captureId),
  ],
);

defineDatabaseTableDescriptions(emailCaptureAttachments, {
  description: "Attachment content and metadata belonging to locally captured emails.",
  columns: {
    captureId: "Public identifier of the captured email that owns the attachment.",
    position: "Zero-based attachment position within the captured email.",
    filename: "Filename supplied for the attachment.",
    content: "Raw decoded attachment content.",
    contentEncoding: "Whether the stored content should be interpreted as binary bytes or text.",
    contentType: "Optional MIME media type of the attachment.",
    disposition: "Optional content disposition indicating an attachment or inline resource.",
    contentId: "Optional content identifier used to reference an inline attachment from HTML.",
  },
});

export type StoredEmailCapture = typeof emailCaptures.$inferSelect;
export type StoredEmailCaptureAttachment =
  typeof emailCaptureAttachments.$inferSelect;
