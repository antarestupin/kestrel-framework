// These disposable development tables are excluded from deployment migrations.
export { devSchema } from "@kestrel/framework/db";
export { logs } from "@kestrel/framework/log";
export { observations } from "@kestrel/framework/observability";
export { emailCaptures, emailCaptureAttachments } from "@kestrel/framework/email/postgres_schema";
