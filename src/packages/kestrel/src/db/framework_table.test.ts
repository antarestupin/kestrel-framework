import { describe, expect, it } from "vitest";
import { pgSchema, pgTable, text } from "drizzle-orm/pg-core";

import { getFrameworkDatabaseTableKeys } from "./framework_table.js";
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
});
