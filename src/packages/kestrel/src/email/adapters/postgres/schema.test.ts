import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";

import { getFrameworkDatabaseTableKeys } from "../../../db/framework_table.js";
import { getDatabaseSchemaContributions } from "../../../db/schema_contributions/index.js";
import { emailCaptureAttachments, emailCaptures } from "../../postgres_schema.js";

it("exports the disposable capture schema used by Drizzle schema push", () => {
  const captures = getTableConfig(emailCaptures);
  const attachments = getTableConfig(emailCaptureAttachments);
  expect([captures.schema, captures.name, attachments.schema, attachments.name]).toEqual([
    "dev", "email_capture", "dev", "email_capture_attachment",
  ]);
  expect(captures.columns.map((column) => [column.name, column.getSQLType(), column.notNull])).toEqual([
    ["sequence", "bigint", true], ["id", "uuid", true], ["observation_id", "uuid", true],
    ["captured_at", "timestamp with time zone", true], ["sender", "jsonb", true],
    ["recipients_to", "jsonb", true], ["recipients_cc", "jsonb", true], ["recipients_bcc", "jsonb", true],
    ["reply_to", "jsonb", true], ["subject", "text", true], ["text_body", "text", false],
    ["html_body", "text", false], ["headers", "jsonb", false], ["attachment_count", "integer", true],
    ["attachment_bytes", "bigint", true], ["created_at", "timestamp with time zone", true],
  ]);
  expect(attachments.columns.map((column) => [column.name, column.getSQLType(), column.notNull])).toEqual([
    ["capture_id", "uuid", true], ["position", "integer", true], ["filename", "text", true],
    ["content", "bytea", true], ["content_encoding", "text", true], ["content_type", "text", false],
    ["disposition", "text", false], ["content_id", "text", false],
  ]);
  expect(emailCaptures.sequence).toMatchObject({ primary: true, dataType: "number", generatedIdentity: { type: "always" } });
  expect(emailCaptures.id).toMatchObject({ isUnique: true, uniqueName: "email_capture_id_unique" });
  expect(emailCaptures.attachmentBytes.dataType).toBe("number");
  expect(emailCaptures.capturedAt.dataType).toBe("date");
  expect(emailCaptures.createdAt).toMatchObject({ dataType: "date", hasDefault: true });
  expect(captures.indexes.map(({ config }) => config)).toMatchObject([
    { name: "email_capture_observation_id_idx", unique: true, columns: [{ name: "observation_id" }] },
    { name: "email_capture_captured_at_idx", unique: false, columns: [{ name: "captured_at" }] },
  ]);
  expect(attachments.indexes.map(({ config }) => config)).toMatchObject([
    { name: "email_capture_attachment_capture_id_idx", columns: [{ name: "capture_id" }] },
  ]);
  expect(attachments.primaryKeys.map(({ columns }) => columns.map(({ name }) => name)))
    .toEqual([["capture_id", "position"]]);
  // Cleanup is transactional in the adapter, so schema push has no dependent foreign keys.
  expect(captures.foreignKeys).toEqual([]);
  expect(attachments.foreignKeys).toEqual([]);

  const tables = { emailCaptures, emailCaptureAttachments };
  expect(getFrameworkDatabaseTableKeys(tables)).toEqual(new Set([
    '["dev","email_capture"]', '["dev","email_capture_attachment"]',
  ]));
  const descriptions = getDatabaseSchemaContributions(tables);
  for (const { name, columns } of [captures, attachments]) {
    const contribution = descriptions.find(({ id }) => id === `postgres.table:dev.${name}:descriptions`);
    expect(contribution?.installSql).toContain(`COMMENT ON TABLE "dev"."${name}" IS '`);
    for (const column of columns) {
      expect(contribution?.installSql).toContain(`COMMENT ON COLUMN "dev"."${name}"."${column.name}" IS '`);
    }
  }
});
