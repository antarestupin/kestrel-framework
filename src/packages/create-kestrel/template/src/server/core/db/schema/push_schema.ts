// Exports disposable development tables for local schema synchronization, excluding deployment migrations.
// Keep these exports aligned with the filters in ../development_schema.ts.

export { devSchema } from "@kestrel/framework/db";
export { logs } from "@kestrel/framework/log";
export { observations } from "@kestrel/framework/observability";
export { emailCaptures, emailCaptureAttachments } from "@kestrel/framework/email/postgres_schema";
