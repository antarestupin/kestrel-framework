import {
  integer,
  json,
  jsonb,
  pgSchema,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  defineHistoryTable,
  getHistoryTableDefinitions,
} from "./definition.js";
import {
  createHistoryBaselineSql,
  createHistoryTriggerRemovalSql,
  createHistoryTriggerSql,
  managedIdentifier,
} from "./trigger_sql.js";

const sqlSchema = pgSchema("history_sql_test");
const articles = sqlSchema.table("article", {
  id: uuid("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content"),
});

describe("createHistoryBaselineSql", () => {
  it("generates a migration-owned baseline only when requested", () => {
    const baselineHistory = defineHistoryTable(articles, {
      name: "article_baseline_history",
      baseline: "existing_rows",
    });
    const [baselineDefinition] = getHistoryTableDefinitions({ baselineHistory });
    const [regularDefinition] = getHistoryTableDefinitions({ articleHistory: defineHistoryTable(articles) });
    const baselineSql = createHistoryBaselineSql(baselineDefinition!);

    expect(createHistoryBaselineSql(regularDefinition!)).toBeUndefined();
    expect(baselineSql).not.toContain("history_baseline");
    expect(baselineSql).toContain(
      'LOCK TABLE "history_sql_test"."article" IN SHARE ROW EXCLUSIVE MODE',
    );
    expect(baselineSql).toContain(
      'FROM "history_sql_test"."article" AS source',
    );
  });
});
describe("createHistoryTriggerSql", () => {
  it("rejects stale source-column metadata before rendering SQL", () => {
    const [definition] = getHistoryTableDefinitions({ articleHistory: defineHistoryTable(articles) });
    const stale = { ...definition!, baseline: "existing_rows" as const, sourceColumnKeys: ["oldColumn"] };
    expect(() => createHistoryTriggerSql(stale)).toThrow('Missing history source column "oldColumn"');
    expect(() => createHistoryBaselineSql(stale)).toThrow('Missing history source column "oldColumn"');
  });

  it("omits untracked columns from baseline, deltas, and update comparisons", () => {
    for (const selection of [{ include: [articles.title] }, { exclude: [articles.content] }]) {
      const filtered = defineHistoryTable(articles, { ...selection, baseline: "existing_rows" });
      const [definition] = getHistoryTableDefinitions({ filtered });
      const trigger = createHistoryTriggerSql(definition!);
      const baseline = createHistoryBaselineSql(definition!);
      expect(trigger).not.toContain('"content"');
      expect(baseline).not.toContain('"content"');
      expect(trigger).toContain('IF NOT (OLD."id" IS DISTINCT FROM NEW."id" OR OLD."title" IS DISTINCT FROM NEW."title")');
      expect(baseline).toContain('source."title"');
    }
  });

  it("generates sparse insert, update and delete event triggers", () => {
    const [definition] = getHistoryTableDefinitions({ articleHistory: defineHistoryTable(articles) });
    const triggerSql = createHistoryTriggerSql(definition!);

    expect(triggerSql).toContain(
      'CREATE OR REPLACE FUNCTION "history_sql_test"."__history_article_history_write"()',
    );
    expect(triggerSql).toContain(
      "CASE WHEN OLD.\"content\" IS DISTINCT FROM NEW.\"content\" THEN NEW.\"content\" ELSE NULL END",
    );
    expect(triggerSql).toContain(
      "array_remove(ARRAY[CASE WHEN OLD.\"id\" IS DISTINCT FROM NEW.\"id\" THEN 'id' END",
    );
    expect(triggerSql).toContain(
      "History identity columns of article are immutable",
    );
    expect(triggerSql).toContain(
      "IF NOT (OLD.\"id\" IS DISTINCT FROM NEW.\"id\"",
    );
    expect(triggerSql).toContain(
      "OLD.\"id\", NULL, NULL, 3, ARRAY[]::text[]",
    );
    expect(triggerSql).toContain(
      "current_setting('kestrel.history.actor', true)",
    );
    for (const key of ["actor", "reason"]) {
      expect(triggerSql.match(new RegExp(`current_setting\\('kestrel\\.history\\.${key}', true\\)`, "gu")))
        .toHaveLength(3);
    }
    expect(triggerSql).toMatch(/AS \$history\$[\s\S]+\$history\$;/u);
  });

  it("combines every column of a composite identity in the immutability check", () => {
    const source = sqlSchema.table("composite_record", {
      tenant: integer("tenant_id").notNull(), id: integer("record_id").notNull(),
    });
    const history = defineHistoryTable(source, { identity: [source.tenant, source.id] });
    const [definition] = getHistoryTableDefinitions({ history });
    expect(createHistoryTriggerSql(definition!)).toContain(
      'IF OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id" OR OLD."record_id" IS DISTINCT FROM NEW."record_id" THEN',
    );
  });

  it("keeps function ownership distinct when two source and history names concatenate identically", () => {
    const first = sqlSchema.table("alpha_beta", { id: integer().primaryKey() });
    const second = sqlSchema.table("alpha", { id: integer().primaryKey() });
    const firstHistory = defineHistoryTable(first, { name: "events" });
    const secondHistory = defineHistoryTable(second, { name: "beta_events" });
    const definitions = getHistoryTableDefinitions({ firstHistory, secondHistory });
    const installed = definitions.map((definition) =>
      createHistoryTriggerSql(definition).match(/^CREATE OR REPLACE FUNCTION (.+)\(\)$/m)?.[1]);

    expect(installed).toHaveLength(2);
    expect(installed.every((name) => name !== undefined)).toBe(true);
    expect(new Set(installed).size).toBe(2);
    for (const [index, definition] of definitions.entries()) {
      expect(createHistoryTriggerRemovalSql(definition)).toContain(`DROP FUNCTION IF EXISTS ${installed[index]}();`);
    }
  });

  it("compares JSON arrays through jsonb and quotes source metadata in both SQL positions", () => {
    const source = sqlSchema.table(`order'"%`, {
      id: integer('id"').primaryKey(),
      ["old'field"]: text('display"'),
      plain: json(),
      bounded: json().array(12),
      binary: jsonb(),
    });
    const history = defineHistoryTable(source, { baseline: "existing_rows" });
    const [definition] = getHistoryTableDefinitions({ history });
    const trigger = createHistoryTriggerSql(definition!);

    expect(trigger).toContain(`ON "history_sql_test"."order'""%"`);
    expect(trigger).toContain('NEW."id"""');
    expect(trigger).toContain('NEW."display"""');
    expect(trigger).toContain("'old''field'");
    expect(trigger).toContain("History identity columns of order''\"%% are immutable");
    expect(trigger).toContain('to_jsonb(OLD."plain") IS DISTINCT FROM to_jsonb(NEW."plain")');
    expect(trigger).toContain('to_jsonb(OLD."bounded") IS DISTINCT FROM to_jsonb(NEW."bounded")');
    expect(trigger).not.toContain('to_jsonb(OLD."binary")');
    expect(createHistoryBaselineSql(definition!)).toContain("'old''field'");
  });
});

describe("managed PostgreSQL history identifiers", () => {
  it("distinguishes old hash collisions beyond the shared visible prefix", () => {
    const prefix = "a".repeat(62);
    expect(managedIdentifier(prefix + "Aa")).not.toBe(managedIdentifier(prefix + "BB"));
  });

  it("preserves identifiers at the 63-byte limit and truncates only between Unicode characters", () => {
    const exact = `${"é".repeat(31)}x`;
    expect(managedIdentifier(exact)).toBe(exact);
    const shortened = managedIdentifier("é".repeat(32));
    expect(Buffer.byteLength(shortened)).toBeLessThanOrEqual(63);
    expect(shortened).toMatch(/^é{23}_[0-9a-f]{16}$/u);
  });
});
