// Drizzle Kit loads schema entrypoints through CommonJS. Keep this facade free
// from transport adapters so ESM-only email SDK modules are never evaluated.
export {
  emailCaptureAttachments,
  emailCaptures,
} from "./adapters/postgres/schema.js";
