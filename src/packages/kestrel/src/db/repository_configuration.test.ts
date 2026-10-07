import { asc, desc, eq, gt, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, text, type PgColumn } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { CollectionQuery, RepositoryCollectionOptions } from "./collection.js";
import { DatabaseManager } from "./database_manager.js";
import type { Pagination } from "./pagination.js";
import { Repository } from "./repository.js";

const records = pgTable("configuration_record", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
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
  public constructor(databaseManager: DatabaseManager) {
    super(databaseManager, { table: records, idColumn: records.id, cursor });
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
      filters: { name: { column: records.name, operators: ["equals"] } },
      sorting: { name: records.name },
    };
  }
}

function setup(configured = false) {
  // Keep real Drizzle SQL compilation while replacing only the database transport.
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const database = drizzle({ client: { query } as never });
  const manager = new DatabaseManager({ database });
  const repository = configured
    ? new ConfiguredRepository(manager)
    : new DefaultRepository(manager);

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

  it.each<Partial<CollectionQuery>>([
    { search: { term: "selected" } },
    { filters: [{ field: "name", operator: "equals", value: "selected" }] },
    { sort: [{ field: "name", direction: "asc" }] },
  ])("rejects unsupported collection criteria before querying: %j", async (criteria) => {
    const { repository, query } = setup();
    await expect(repository.findCollection({ pagination: page, ...criteria }))
      .rejects.toThrow(TypeError);
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
