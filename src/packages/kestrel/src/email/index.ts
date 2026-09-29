export * from "./adapters/index.js";
export {
  contentBytes,
  EmailCaptureInbox,
  EmailCaptureNotFoundError,
  summarizeEmailCapture,
  type EmailCapture,
  type EmailCaptureInboxSource,
  type EmailCapturePage,
  type EmailCapturePageOptions,
  type EmailCaptureResendResult,
  type EmailCaptureStore,
  type EmailCaptureSummary,
  type NewEmailCapture,
} from "./capture.js";
export { EmailClient } from "./client.js";
export {
  emailCaptureInboxDependency,
  emailCaptureStoreDependency,
  emailClientDependency,
} from "./dependencies.js";
export {
  emailConfigBase,
  emailDriverConfigSchema,
  type EmailConfig,
  type EmailDriverConfig,
  type SesEmailDriverConfig,
  type SmtpEmailDriverConfig,
} from "./configuration.js";
export {
  EmailDriverError,
  EmailSendError,
  normalizeEmailSendError,
  type EmailDriverErrorOptions,
  type EmailErrorCode,
} from "./errors.js";
export { normalizeEmailMessage } from "./message.js";
export {
  emailSendObservation,
  recordEmailInstrumentation,
  type EmailInstrumentation,
  type EmailInstrumentationEvent,
  type EmailSendObservationData,
  type EmailSendResult,
} from "./observations.js";
export {
  EmailProvider,
  type EmailProviderOptions,
} from "./provider.js";
export type {
  EmailAddress,
  EmailAddressInput,
  EmailAttachment,
  EmailClientOptions,
  EmailDriver,
  EmailDriverContext,
  EmailMessage,
  EmailMessageInput,
  EmailReceipt,
  EmailSendOptions,
} from "./types.js";
