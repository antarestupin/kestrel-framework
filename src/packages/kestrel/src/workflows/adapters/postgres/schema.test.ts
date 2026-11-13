import { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

/** Load the production declarations within a test so import-time failures are observable. */
async function loadSchema() {
  // Mutation testing can run this test against a module cached by another schema assertion.
  vi.resetModules();
  const {
    workflowDispatchOutbox,
    workflowExecutions,
    workflowHistoryArchives,
    workflowHistoryEvents,
    workflowSignals,
    workflowTasks,
    workflowsSchema,
  } = await import("./schema.js");
  const { getFrameworkDatabaseTableKeys } = await import("../../../db/framework_table.js");
  const { getDatabaseSchemaContributions } = await import("../../../db/schema_contributions/definition.js");
  const tables = { workflowDispatchOutbox, workflowExecutions, workflowHistoryArchives, workflowHistoryEvents, workflowSignals, workflowTasks };
  return { ...tables, tables, workflowsSchema, getFrameworkDatabaseTableKeys, getDatabaseSchemaContributions };
}

/** Exercise production migration metadata independently from adapter fixtures. */
describe("workflow PostgreSQL schema", () => {
  it("exposes the singular framework-owned tables and their column comments", async () => {
    const { tables, workflowsSchema, getFrameworkDatabaseTableKeys, getDatabaseSchemaContributions } = await loadSchema();
    const tableNames = ["dispatch_outbox", "execution", "history_archive", "history_event", "signal", "task"];
    expect(getFrameworkDatabaseTableKeys(tables)).toEqual(new Set(tableNames.map((name) => JSON.stringify(["workflows", name]))));
    const contributions = getDatabaseSchemaContributions({ workflowsSchema, ...tables });
    expect(contributions.find(({ id }) => id === "postgres.schema:workflows:description")?.installSql)
      .toContain('COMMENT ON SCHEMA "workflows" IS ');
    for (const table of Object.values(tables)) {
      const { schema, name, columns, indexes } = getTableConfig(table);
      expect(schema).toBe("workflows");
      expect(tableNames).toContain(name);
      const comment = contributions.find(({ id }) => id === `postgres.table:workflows.${name}:descriptions`);
      expect(comment?.installSql).toContain(`COMMENT ON TABLE "workflows"."${name}" IS `);
      expect(new Set(columns.map((column) => column.name)).size).toBe(columns.length);
      for (const column of columns) {
        expect(column.name).toMatch(/^[a-z][a-z0-9_]*$/u);
        expect(comment?.installSql).toContain(`COMMENT ON COLUMN "workflows"."${name}"."${column.name}" IS `);
      }
      for (const index of indexes) {
        if (index.config.name !== undefined) expect(index.config.name.length).toBeGreaterThan(0);
      }
    }
  });

  it("enforces one journal position, completion, wakeup, signal key and dispatch per identity", async () => {
    const { tables, workflowHistoryEvents, workflowHistoryArchives, workflowTasks, workflowSignals, workflowDispatchOutbox } = await loadSchema();
    const primary = (table: typeof workflowHistoryEvents | typeof workflowHistoryArchives) =>
      getTableConfig(table).primaryKeys.map(({ columns }) => columns.map(({ name }) => name));
    expect(primary(workflowHistoryEvents)).toEqual([["execution_id", "event_index"]]);
    expect(primary(workflowHistoryArchives)).toEqual([["execution_id", "history_generation"]]);

    const dialect = new PgDialect();
    const unique = (table: typeof tables[keyof typeof tables]) => getTableConfig(table).indexes
      .filter(({ config }) => config.unique)
      .map(({ config }) => ({
        columns: config.columns.map((column) => "name" in column ? column.name : undefined),
        predicate: config.where === undefined ? undefined : dialect.sqlToQuery(config.where).sql,
      }));
    expect(unique(workflowHistoryEvents)).toEqual([
      { columns: ["execution_id", "command_sequence"], predicate: expect.stringContaining('"type" = \'command-scheduled\'') },
      { columns: ["execution_id", "command_sequence"], predicate: expect.stringContaining('"type" = \'command-completed\'') },
    ]);
    expect(unique(workflowTasks)).toEqual([{ columns: ["execution_id"], predicate: expect.stringContaining('"kind" = \'workflow\'') }]);
    expect(unique(workflowSignals)).toEqual([{ columns: ["execution_id", "idempotency_key"], predicate: expect.stringContaining('"idempotency_key" IS NOT NULL') }]);
    expect(unique(workflowDispatchOutbox)).toEqual([{ columns: ["execution_id", "command_sequence", "transport"], predicate: undefined }]);
  });

  it("preserves the journal defaults, nullable values and Date-valued lease columns", async () => {
    const { workflowExecutions, workflowHistoryEvents, workflowTasks, workflowSignals, workflowDispatchOutbox, workflowHistoryArchives } = await loadSchema();
    expect(workflowExecutions.historyGeneration).toMatchObject({ default: 1, notNull: true });
    expect(workflowExecutions.revision).toMatchObject({ default: 0, notNull: true });
    expect(workflowExecutions.outputPresent).toMatchObject({ default: false, notNull: true });
    expect(workflowExecutions.cancellationRequested).toMatchObject({ default: false, notNull: true });
    expect(workflowExecutions.concurrencyAdmitted).toMatchObject({ default: true, notNull: true });
    expect(workflowHistoryEvents.payloadPresent).toMatchObject({ default: false, notNull: true });
    for (const column of [workflowExecutions.input, workflowExecutions.output, workflowTasks.payload, workflowSignals.payload, workflowDispatchOutbox.payload]) {
      expect(column.notNull).toBe(false);
    }
    for (const table of [workflowTasks, workflowDispatchOutbox]) {
      expect(table.id).toMatchObject({ primary: true, hasDefault: true });
      expect(table.attempt).toMatchObject({ default: 0, notNull: true });
      expect(table.reservationToken.notNull).toBe(false);
      expect(table.availableAt).toMatchObject({ hasDefault: true, notNull: true });
      expect(table.reservedAt.notNull).toBe(false);
    }
    const dialect = new PgDialect();
    for (const { id } of [workflowTasks, workflowSignals, workflowDispatchOutbox]) {
      // UUIDv7 preserves the storage-generated identity used as a reservation-order tie-breaker.
      expect(id.default).toBeInstanceOf(SQL);
      expect(dialect.sqlToQuery(id.default as SQL).sql).toBe("uuidv7()");
    }
    for (const column of [workflowTasks.availableAt, workflowTasks.reservedAt, workflowTasks.createdAt,
      workflowDispatchOutbox.availableAt, workflowDispatchOutbox.reservedAt, workflowDispatchOutbox.publishedAt, workflowDispatchOutbox.createdAt,
      workflowExecutions.createdAt, workflowExecutions.updatedAt, workflowExecutions.completedAt, workflowExecutions.pausedAt,
      workflowHistoryEvents.occurredAt, workflowHistoryArchives.continuedAt, workflowSignals.receivedAt, workflowSignals.consumedAt]) {
      expect(column.getSQLType()).toBe("timestamp with time zone");
      expect(column.dataType).toBe("date");
    }
  });

  it("indexes reservation order, signal delivery and workflow lineage", async () => {
    const { tables, workflowTasks, workflowDispatchOutbox, workflowSignals, workflowExecutions } = await loadSchema();
    const indexes = (table: typeof tables[keyof typeof tables]) => getTableConfig(table).indexes
      .filter(({ config }) => !config.unique)
      .map(({ config }) => config.columns.map((column) => "name" in column ? column.name : undefined));
    expect(indexes(workflowTasks)).toEqual([["kind", "available_at", "id"], ["execution_id", "kind"]]);
    expect(indexes(workflowDispatchOutbox)).toEqual([["published_at", "available_at"]]);
    expect(indexes(workflowSignals)).toEqual([["execution_id", "name", "received_at"]]);
    expect(indexes(workflowExecutions)).toEqual([
      ["status", "updated_at"], ["workflow_name", "workflow_version", "status"],
      ["parent_execution_id", "created_at"], ["root_execution_id", "created_at"], ["retry_of_execution_id"],
    ]);
  });

  it("preserves durable index identities and server-side timestamp defaults", async () => {
    const { tables, workflowTasks, workflowDispatchOutbox, workflowExecutions, workflowHistoryArchives, workflowHistoryEvents, workflowSignals } = await loadSchema();
    // Migration tooling compares index names and defaults across revisions.
    const indexes = Object.fromEntries(Object.values(tables).map((table) => {
      const config = getTableConfig(table);
      return [config.name, config.indexes.map(({ config: index }) => index.name)];
    }));
    expect(indexes).toEqual({
      dispatch_outbox: ["dispatch_outbox_command_idx", "dispatch_outbox_available_idx"],
      execution: ["execution_status_updated_idx", "execution_definition_version_idx", "execution_parent_idx",
        "execution_root_idx", "execution_retry_idx"],
      history_archive: [],
      history_event: ["history_command_schedule_idx", "history_command_completion_idx"],
      signal: ["signal_execution_idempotency_idx", "signal_consumption_idx"],
      task: ["task_reservation_idx", "task_execution_idx", "task_workflow_wakeup_idx"],
    });
    const dialect = new PgDialect();
    for (const column of [
      workflowTasks.availableAt, workflowTasks.createdAt, workflowDispatchOutbox.availableAt,
      workflowDispatchOutbox.createdAt, workflowExecutions.createdAt, workflowExecutions.updatedAt,
      workflowHistoryArchives.continuedAt, workflowHistoryEvents.occurredAt, workflowSignals.receivedAt,
    ]) {
      expect(column.default).toBeInstanceOf(SQL);
      expect(dialect.sqlToQuery(column.default as SQL).sql).toBe("now()");
    }
  });
});
