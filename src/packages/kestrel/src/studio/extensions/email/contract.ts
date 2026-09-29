import type { ObservationOutcome } from "../../../observability/index.js";

export const DEV_EMAIL_EXTENSION_ID = "development-email";
export const DEV_EMAIL_HISTORY_PAGE_KIND = "development-email-history";
export const DEV_EMAIL_INBOX_PAGE_KIND = "development-email-inbox";
export const DEV_EMAIL_CAPTURE_PAGE_KIND = "development-email-capture";
export const DEV_EMAIL_DATA_PATH = "/api/extensions/development-email" as const;

export interface StudioEmailAddress {
  address: string;
  name: string | null;
}

export interface StudioEmailCaptureSummary {
  sequence: number;
  id: string;
  observationId: string;
  capturedAt: string;
  from: StudioEmailAddress;
  to: readonly StudioEmailAddress[];
  cc: readonly StudioEmailAddress[];
  bcc: readonly StudioEmailAddress[];
  subject: string;
  hasText: boolean;
  hasHtml: boolean;
  attachmentCount: number;
  attachmentBytes: number;
}

export interface StudioEmailCapturePage {
  items: readonly StudioEmailCaptureSummary[];
  nextBefore: number | null;
}

export interface StudioEmailHistoryItem {
  sequence: number;
  id: string;
  executionId: string;
  occurredAt: string;
  outcome: ObservationOutcome | null;
  durationMs: number | null;
  client: string | null;
  operation: string | null;
  transport: string | null;
  result: string | null;
  recipientCount: number | null;
  attachmentCount: number | null;
  captureId: string | null;
}

export interface StudioEmailHistoryPage {
  items: readonly StudioEmailHistoryItem[];
  nextBefore: number | null;
}

export interface StudioEmailAttachment {
  filename: string;
  contentType: string | null;
  disposition: "attachment" | "inline" | null;
  contentId: string | null;
  size: number;
}

export interface StudioEmailObservation {
  id: string;
  executionId: string;
  occurredAt: string;
  outcome: ObservationOutcome | null;
  durationMs: number | null;
  operation: string | null;
  transport: string | null;
  result: string | null;
}

export interface StudioEmailCaptureDetail extends StudioEmailCaptureSummary {
  replyTo: readonly StudioEmailAddress[];
  text: string | null;
  html: string | null;
  headers: Readonly<Record<string, string>>;
  attachments: readonly StudioEmailAttachment[];
  observation: StudioEmailObservation | null;
}

export interface StudioEmailResendResult {
  captureId: string | null;
  messageId: string | null;
}

export function getStudioEmailCapturePath(
  captureId: string,
): `/emails/${string}` {
  return `/emails/${encodeURIComponent(captureId)}`;
}
