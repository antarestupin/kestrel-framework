// Defines schema and table filters for local database synchronization and reset operations.
// Keep these filters aligned with every table exported by schema/push_schema.ts.

export const developmentSchemaFilter = ["dev"];
export const developmentTablesFilter = ["log", "observation", "email_capture", "email_capture_attachment"];
