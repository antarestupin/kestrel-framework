import { asc, desc, eq, gt, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { boolean, integer, pgTable, text, timestamp, type PgColumn } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { CollectionQuery, RepositoryCollectionOptions } from "./collection.js";
import { PostgresDrizzleManager } from "./database_manager.js";
import type { Pagination } from "./pagination.js";
import { Repository } from "./repository.js";

const records = pgTable("configuration_record", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  rank: integer("rank").notNull(),
  active: boolean("active").notNull(),
  recordedAt: timestamp("recorded_at", { mode: "string", withTimezone: true }).notNull(),
});
const page = { type: "page", page: 1, pageSize: 2 } as const;
const cursor = {
  orderBy: [asc(records.id)] as const,
  getCursor: (record: typeof records.$inferSelect) => record.id,
  getCondition: (after: number) => gt(records.id, after),
};

// Inherit both default hooks to exercise repositories configured only for storage.
class DefaultRepository extends Repository<
  typeof records,
  number,
  typeof records.$inferInsert,
  Partial<typeof records.$inferInsert>,
  number
> {
  public constructor(databaseManager: PostgresDrizzleManager, enableCursor: boolean) {
    super(databaseManager, { table: records, idColumn: records.id, ...(enableCursor ? { cursor } : {}) });
  }

  /** Expose explicit ordering so cursor rejection covers the protected API. */
  public findNamed(
    pagination: Pagination<number>,
    orderBy?: readonly (PgColumn | SQL | SQL.Aliased)[],
  ) {
    return this.findAllWhere(eq(records.name, "selected"), pagination, orderBy);
  }
}

class ConfiguredRepository extends DefaultRepository {
  /** A fresh array on every read must not affect cursor handling. */
  protected override getOrderBy() {
    return [desc(records.name), asc(records.id)];
  }

  /** Resolve caller-facing field names through an explicit allowlist. */
  protected override getCollectionConfiguration(): RepositoryCollectionOptions {
    return {
      search: { name: records.name },
      filters: {
        name: { column: records.name, operators: ["equals", "not-equals"] },
        rank: { column: records.rank, operators: ["equals"] },
        active: { column: records.active, operators: ["equals"] },
        recordedAt: { column: records.recordedAt, operators: ["equals"] },
        missing: { column: null, operators: ["equals"] },
      },
      sorting: { name: records.name },
    };
  }
}

function setup(configured = false, enableCursor = true) {
  // Keep real Drizzle SQL compilation while replacing only the database transport.
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const database = drizzle({ client: { query } as never });
  const manager = new PostgresDrizzleManager({ database });
  const repository = configured
    ? new ConfiguredRepository(manager, enableCursor)
    : new DefaultRepository(manager, enableCursor);

  return {
    repository,
    query,
    sql: () => query.mock.calls.at(-1)![0].text as string,
  };
}

describe("repository configuration hooks", () => {
  it("allows all read helpers without a default ordering", async () => {
    const { repository, query } = setup();
    await repository.findAll();
    await repository.findAll(page);
    await repository.findManyByIds([2, 1]);
    await repository.findNamed(page);
    await repository.findCollection({ pagination: page });
    await repository.findCollection({
      pagination: page, search: { term: "" }, filters: [], sort: [],
    });

    expect(query).toHaveBeenCalledTimes(6);
    for (const [statement] of query.mock.calls) {
      expect(statement.text).not.toContain("order by");
    }
    expect(query.mock.calls[1]![0].text).toContain("limit $1");
  });

  it.each<[Partial<CollectionQuery>, string]>([
    [{ search: { term: "selected" } }, "This repository does not support collection search."],
    [{ filters: [{ field: "name", operator: "equals", value: "selected" }] }, 'Collection filter "name.equals" is not supported.'],
    [{ sort: [{ field: "name", direction: "asc" }] }, 'This repository does not support sorting "name".'],
  ])("rejects unsupported collection criteria before querying: %j", async (criteria, message) => {
    const { repository, query } = setup();
    await expect(repository.findCollection({ pagination: page, ...criteria }))
      .rejects.toThrow(message);
    expect(query).not.toHaveBeenCalled();
  });

  it("omits empty ID queries and still supports numbered reads without a cursor contract", async () => {
    const { repository, query, sql } = setup(false, false);
    await expect(repository.findManyByIds([])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
    await expect(repository.findAll(page)).resolves.toMatchObject({
      items: [], pageInfo: { type: "page", hasNextPage: false },
    });
    expect(sql()).toContain("limit $1");
  });

  it("rejects a missing INSERT result when returning is requested", async () => {
    const { repository, query, sql } = setup();
    await expect(repository.create({ id: 1, name: "new", rank: 0, active: false, recordedAt: "2026-01-01T00:00:00Z" }, {
      returning: true,
    })).rejects.toThrow("The repository create operation did not return a record.");
    expect(query).toHaveBeenCalledOnce();
    expect(sql()).toContain("returning");
  });

  it("normalizes wire numbers and booleans but preserves string-mode timestamp values", async () => {
    const { repository, query, sql } = setup(true);
    const recordedAt = "2026-01-02 03:04:05+01";
    await repository.findCollection({
      pagination: page,
      filters: [
        { field: "rank", operator: "equals", value: "42" },
        { field: "active", operator: "equals", value: "true" },
        { field: "active", operator: "equals", value: "false" },
        { field: "active", operator: "equals", value: "native-boolean-spelling" },
        { field: "recordedAt", operator: "equals", value: recordedAt },
      ],
      sort: [{ field: "name", direction: "desc" }],
    });
    // Assert the driver arguments before PostgreSQL's implicit coercions.
    expect(query.mock.calls[0]![1]).toEqual([42, true, false, "native-boolean-spelling", recordedAt, 3]);
    expect(sql()).toContain('order by "configuration_record"."name" desc limit');
    await expect(repository.findCollection({
      pagination: page, filters: [{ field: "missing", operator: "equals", value: "ignored" }],
    })).rejects.toThrow('This repository does not support filter "missing".');
    expect(query).toHaveBeenCalledOnce();
  });

  it("keeps a not-equals predicate distinct from the next comparison operator", async () => {
    const { repository, query, sql } = setup(true);
    await repository.findCollection({ pagination: page, filters: [{ field: "name", operator: "not-equals", value: "hidden" }] });
    expect(sql()).toContain('"configuration_record"."name" <>');
    expect(query.mock.calls[0]![1]).toEqual(["hidden", 3]);
  });

  it("rejects invalid numbered pagination before executing an unbounded select", async () => {
    const { repository, query } = setup();
    await expect(repository.findAll({ type: "page", page: 1, pageSize: NaN }))
      .rejects.toThrow("positive safe integers");
    expect(query).not.toHaveBeenCalled();
  });

  it("applies overridden default ordering to every non-cursor read helper", async () => {
    const { repository, query } = setup(true);
    await repository.findAll();
    await repository.findAll(page);
    await repository.findManyByIds([2, 1]);
    await repository.findNamed(page);
    await repository.findCollection({ pagination: page });
    await repository.findCollection({ pagination: page, sort: [] });

    expect(query).toHaveBeenCalledTimes(6);
    for (const [statement] of query.mock.calls) {
      expect(statement.text).toContain(
        'order by "configuration_record"."name" desc, "configuration_record"."id" asc',
      );
    }
  });

  it("uses overridden collection criteria and replaces default ordering", async () => {
    const { repository, query, sql } = setup(true);
    await repository.findCollection({
      pagination: page,
      search: { term: "match" },
      filters: [{ field: "name", operator: "equals", value: "selected" }],
      sort: [{ field: "name", direction: "asc" }],
    });

    expect(sql()).toContain('"name" ilike $1');
    expect(sql()).toContain('"name" = $2');
    expect(sql()).toContain('order by "configuration_record"."name" asc limit');
    expect(query.mock.calls[0]![1]).toEqual(["%match%", "selected", 3]);
  });

  it("rejects inherited property names as caller-selected collection fields", async () => {
    const { repository, query } = setup(true);

    // Object prototype members are not columns declared by the repository.
    for (const field of ["constructor", "__proto__", "toString"]) {
      await expect(repository.findCollection({
        pagination: page, filters: [{ field, operator: "equals", value: "selected" }],
      })).rejects.toThrow(`Collection filter "${field}.equals" is not supported.`);
      await expect(repository.findCollection({
        pagination: page, sort: [{ field, direction: "asc" }],
      })).rejects.toThrow(`This repository does not support sorting "${field}".`);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("lets explicit non-cursor ordering replace the default, including an empty order", async () => {
    const { repository, sql } = setup(true);
    await repository.findNamed(page, [desc(records.id)]);
    expect(sql()).toContain('order by "configuration_record"."id" desc');
    await repository.findNamed(page, []);
    expect(sql()).not.toContain("order by");
  });

  it.each([false, true])("uses cursor ordering independently of default hooks (%s)", async (configured) => {
    const { repository, sql } = setup(configured);
    // Both repeated calls and filtered reads must ignore fresh default-order arrays.
    await repository.findAll({ type: "cursor", pageSize: 2 });
    await repository.findNamed({ type: "cursor", pageSize: 2, after: 10 });
    expect(sql()).toContain('order by "configuration_record"."id" asc');
    expect(sql()).toContain('"name" = $1 and "configuration_record"."id" > $2');
    expect(sql()).not.toContain("offset");
  });

  it.each([{ orderBy: [] }, { orderBy: cursor.orderBy }])("rejects any explicit cursor ordering: %j", async ({ orderBy }) => {
    const { repository, query } = setup(true);
    await expect(repository.findNamed({ type: "cursor", pageSize: 2 }, orderBy))
      .rejects.toThrow("Cursor pagination must use its configured ordering.");
    expect(query).not.toHaveBeenCalled();
  });
});
