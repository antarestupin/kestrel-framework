import {
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
  createHistoryTriggerSql,
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
    const [regularDefinition] = getHistoryTableDefinitions({ articleHistory });
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
const articleHistory = defineHistoryTable(articles);

describe("createHistoryTriggerSql", () => {
  it("generates sparse insert, update and delete event triggers", () => {
    const [definition] = getHistoryTableDefinitions({ articleHistory });
    const triggerSql = createHistoryTriggerSql(definition!);

    expect(triggerSql).toContain(
      'CREATE OR REPLACE FUNCTION "history_sql_test"."__history_article_article_history_write"()',
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
  });
});
