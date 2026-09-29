import { dep } from "../di/index.js";
import type {
  EmailCaptureInboxSource,
  EmailCaptureStore,
} from "./capture.js";
import type { EmailClient } from "./client.js";

/** Application-owned transactional email client. */
export const emailClientDependency = dep<EmailClient>("emailClient");

/** Development email capture storage owned by the composing application. */
export const emailCaptureStoreDependency = dep<EmailCaptureStore>(
  "emailCaptureStore",
);

/** Studio-facing development inbox with explicit replay controls. */
export const emailCaptureInboxDependency = dep<EmailCaptureInboxSource>(
  "emailCaptureInbox",
);
