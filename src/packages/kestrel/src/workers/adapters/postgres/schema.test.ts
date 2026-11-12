import { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { getFrameworkDatabaseTableKeys } from "../../../db/framework_table.js";
import { getDatabaseSchemaContributions } from "../../../db/schema_contributions/index.js";

/** Review the actual migration exports independently of connection-local SQL fixtures. */
describe("worker PostgreSQL schema contracts", () => {
  it("keeps singular qualified table identities and migration provenance", async () => {
    // Observe import-time schema validation as a test failure when a declaration is malformed.
    const { workerDeadLetterJobs, workerJobs, workerQueueControls } = await import("./schema.js");
    expect(getFrameworkDatabaseTableKeys({ workerJobs, workerDeadLetterJobs, workerQueueControls })).toEqual(new Set([
      JSON.stringify(["workers", "job"]), JSON.stringify(["workers", "dead_letter_queue"]), JSON.stringify(["workers", "queue_control"]),
    ]));
    expect(getTableConfig(workerJobs)).toMatchObject({ schema: "workers", name: "job" });
    expect(getTableConfig(workerDeadLetterJobs)).toMatchObject({ schema: "workers", name: "dead_letter_queue" });
    expect(getTableConfig(workerQueueControls)).toMatchObject({ schema: "workers", name: "queue_control" });
  });

  it("maps the raw SQL fields and ownership identities explicitly", async () => {
    const { workerDeadLetterJobs, workerJobs, workerQueueControls } = await import("./schema.js");
    expect(getTableConfig(workerJobs).columns.map((column) => column.name)).toEqual(["id", "identity", "queue", "payload", "correlation", "group_id", "execution_id", "attempt", "available_at", "reserved_at", "reservation_token", "state", "last_error", "created_at"]);
    expect(getTableConfig(workerDeadLetterJobs).columns.map((column) => column.name)).toEqual(["id", "original_job_id", "identity", "queue", "payload", "correlation", "group_id", "execution_id", "attempt", "error", "created_at", "failed_at"]);
    expect(getTableConfig(workerQueueControls).columns.map((column) => column.name)).toEqual(["queue", "enabled", "updated_at"]);
    expect(workerJobs.id.primary).toBe(true);
    expect(workerDeadLetterJobs.id.primary).toBe(true);
    expect(workerQueueControls.queue.primary).toBe(true);
  });

  it("preserves safe defaults, required durable fields and timezone-aware dates", async () => {
    const { workerDeadLetterJobs, workerJobs, workerQueueControls } = await import("./schema.js");
    expect(workerQueueControls.enabled.default).toBe(true);
    expect(workerQueueControls.enabled.notNull).toBe(true);
    expect(workerJobs.attempt.default).toBe(0);
    expect(workerJobs.state.default).toBe("pending");
    for (const column of [workerJobs.queue, workerJobs.payload, workerJobs.attempt, workerJobs.state, workerDeadLetterJobs.originalJobId, workerDeadLetterJobs.queue, workerDeadLetterJobs.payload, workerDeadLetterJobs.attempt, workerDeadLetterJobs.error]) expect(column.notNull).toBe(true);
    for (const column of [workerQueueControls.updatedAt, workerJobs.availableAt, workerJobs.reservedAt, workerJobs.createdAt, workerDeadLetterJobs.createdAt, workerDeadLetterJobs.failedAt]) {
      expect(column.getSQLType()).toBe("timestamp with time zone");
      expect(column.dataType).toBe("date");
    }
    for (const column of [workerQueueControls.updatedAt, workerJobs.availableAt, workerJobs.createdAt, workerDeadLetterJobs.failedAt]) {
      expect(column.hasDefault).toBe(true);
      expect(column.notNull).toBe(true);
    }
    expect(workerDeadLetterJobs.createdAt.notNull).toBe(true);
  });

  it("indexes identity uniqueness and the reservation/dead-letter access paths", async () => {
    const { workerDeadLetterJobs, workerJobs } = await import("./schema.js");
    const jobs = getTableConfig(workerJobs).indexes;
    const columns = (index: typeof jobs[number]) => index.config.columns.map((column) => "name" in column ? column.name : undefined);
    expect(jobs.some((index) => index.config.unique && index.config.where !== undefined && columns(index).join() === "identity")).toBe(true);
    expect(jobs.map(columns)).toContainEqual(["queue", "available_at", "id"]);
    expect(jobs.some((index) => index.config.where !== undefined && columns(index).join() === "queue,available_at")).toBe(true);
    expect(getTableConfig(workerDeadLetterJobs).indexes.map(columns)).toEqual(expect.arrayContaining([["queue", "failed_at"], ["original_job_id"]]));
    for (const table of [workerJobs, workerDeadLetterJobs]) for (const index of getTableConfig(table).indexes) {
      // Names may evolve, but explicit empty SQL identifiers are invalid.
      if (index.config.name !== undefined) expect(index.config.name.length).toBeGreaterThan(0);
    }
  });

  it("generates UUIDv7 defaults and predicates for the two partial indexes", async () => {
    const { workerDeadLetterJobs, workerJobs } = await import("./schema.js");
    const dialect = new PgDialect();
    for (const id of [workerJobs.id, workerDeadLetterJobs.id]) {
      expect(id.default).toBeInstanceOf(SQL);
      expect(dialect.sqlToQuery(id.default as SQL)).toMatchObject({ sql: "uuidv7()", params: [] });
    }

    // Render the actual Drizzle migration expressions, including column mapping.
    const { indexes } = getTableConfig(workerJobs);
    const predicates = indexes.flatMap(({ config }) => config.where === undefined
      ? []
      : [{ unique: config.unique, ...dialect.sqlToQuery(config.where, "indexes") }]);
    expect(predicates).toEqual([
      expect.objectContaining({ unique: true, sql: '"identity" IS NOT NULL', params: [] }),
      expect.objectContaining({ unique: false, sql: '"state" = \'reserved\'', params: [] }),
    ]);
  });

  it("preserves operator-facing SQL descriptions for every exported column", async () => {
    const { workerDeadLetterJobs, workerJobs, workerQueueControls } = await import("./schema.js");
    for (const table of [workerJobs, workerDeadLetterJobs, workerQueueControls]) {
      const { name, columns } = getTableConfig(table);
      const [descriptions] = getDatabaseSchemaContributions({ table });
      expect(descriptions?.installSql).toContain(`COMMENT ON TABLE "workers"."${name}" IS `);
      for (const column of columns) {
        expect(descriptions?.installSql).toContain(`COMMENT ON COLUMN "workers"."${name}"."${column.name}" IS `);
      }
    }
  });
});
