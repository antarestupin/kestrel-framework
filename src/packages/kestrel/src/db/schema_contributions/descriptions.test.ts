import {
  pgSchema,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  defineDatabaseSchemaDescription,
  defineDatabaseTableDescriptions,
} from "./descriptions.js";
import { getDatabaseSchemaContributions } from "./definition.js";

describe("database descriptions", () => {
  it("defines the lifecycle of a PostgreSQL schema comment", () => {
    const schema = defineDatabaseSchemaDescription(
      pgSchema('content"archive'),
      "Content owner's archive.",
    );

    expect(getDatabaseSchemaContributions({ schema })).toEqual([{
      id: 'postgres.schema:content"archive:description',
      installSql: `COMMENT ON SCHEMA "content""archive" IS 'Content owner''s archive.';`,
      updateSql: `COMMENT ON SCHEMA "content""archive" IS 'Content owner''s archive.';`,
      uninstallBeforeSql: `COMMENT ON SCHEMA "content""archive" IS NULL;`,
    }]);
  });

  it("uses physical table and column names in declaration order", () => {
    const entries = defineDatabaseTableDescriptions(
      pgTable("audit_entry", {
        content: text("content").notNull(),
        createdAt: timestamp("created_at").notNull(),
      }),
      {
        description: "An immutable audit entry.",
        columns: {
          createdAt: "When the entry was created.",
          content: "The recorded content.",
        },
      },
    );

    expect(getDatabaseSchemaContributions({ entries })).toEqual([{
      id: "postgres.table:public.audit_entry:descriptions",
      installSql: [
        `COMMENT ON TABLE "public"."audit_entry" IS 'An immutable audit entry.';`,
        `COMMENT ON COLUMN "public"."audit_entry"."content" IS 'The recorded content.';`,
        `COMMENT ON COLUMN "public"."audit_entry"."created_at" IS 'When the entry was created.';`,
      ].join("\n"),
      updateSql: [
        `COMMENT ON TABLE "public"."audit_entry" IS 'An immutable audit entry.';`,
        `COMMENT ON COLUMN "public"."audit_entry"."content" IS 'The recorded content.';`,
        `COMMENT ON COLUMN "public"."audit_entry"."created_at" IS 'When the entry was created.';`,
      ].join("\n"),
      uninstallBeforeSql: [
        `COMMENT ON TABLE "public"."audit_entry" IS NULL;`,
        `COMMENT ON COLUMN "public"."audit_entry"."content" IS NULL;`,
        `COMMENT ON COLUMN "public"."audit_entry"."created_at" IS NULL;`,
      ].join("\n"),
    }]);
  });

  it("supports column-only descriptions in a PostgreSQL schema", () => {
    const schema = pgSchema("content");
    const entries = defineDatabaseTableDescriptions(
      schema.table("entry", { title: text("title") }),
      { columns: { title: "The entry title." } },
    );

    expect(getDatabaseSchemaContributions({ entries })[0]).toMatchObject({
      id: "postgres.table:content.entry:descriptions",
      installSql: `COMMENT ON COLUMN "content"."entry"."title" IS 'The entry title.';`,
    });
  });

  it("rejects empty and unknown descriptions", () => {
    const entries = pgTable("entry", { title: text("title") });

    expect(() => defineDatabaseTableDescriptions(entries, {})).toThrow(
      "require a table or column description",
    );
    expect(() => defineDatabaseTableDescriptions(entries, {
      description: " ",
    })).toThrow("cannot be empty");
    expect(() => defineDatabaseTableDescriptions(entries, {
      columns: { missing: "Unknown." },
    } as never)).toThrow("does not match a Drizzle column property");
  });
});
