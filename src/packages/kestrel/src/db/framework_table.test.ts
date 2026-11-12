import { describe, expect, it } from "vitest";
import { pgSchema, pgTable, text } from "drizzle-orm/pg-core";

import { getFrameworkDatabaseTableKeys, markFrameworkDatabaseTable } from "./framework_table.js";
import { createPostgresTokenTable } from "../tokens/adapters/postgres/schema.js";
import { logs } from "../log/db/schema.js";
import { defineDatabaseTableDescriptions } from "./schema_contributions/descriptions.js";

// Discovery uses real library definitions rather than names or schema-wide ownership.
describe("framework table provenance", () => {
  it("follows renamed factories, aliases and qualified identifiers without marking application tables", () => {
    const tokens = createPostgresTokenTable(pgSchema("custom.namespace"), { tableName: "custom_token" });
    const app = defineDatabaseTableDescriptions(pgTable("log", { value: text("value") }), { description: "Application table." });
    const keys = getFrameworkDatabaseTableKeys({ tokens, alias: tokens, logs, app, arbitrary: {}, value: null });
    expect(keys).toEqual(new Set([
      JSON.stringify(["custom.namespace", "custom_token"]), JSON.stringify(["dev", "log"]),
    ]));
    expect(Object.keys(tokens)).not.toContain("origin");
  });

  it("marks an unqualified table once and discovers its public schema key", () => {
    const entry = pgTable("entry", { value: text("value") });
    const columns = Object.keys(entry);

    // Factories can mark the same table again without changing its Drizzle shape.
    expect(markFrameworkDatabaseTable(entry)).toBe(entry);
    expect(markFrameworkDatabaseTable(entry)).toBe(entry);
    expect(Object.keys(entry)).toEqual(columns);
    expect(Object.getOwnPropertyDescriptor(entry, Symbol.for("kestrel.database.frameworkTable")))
      .toEqual({ value: true, enumerable: false, configurable: false, writable: false });
    expect(getFrameworkDatabaseTableKeys({ entry, alias: entry, ignored: "entry" }))
      .toEqual(new Set([JSON.stringify(["public", "entry"])]));
  });
});
