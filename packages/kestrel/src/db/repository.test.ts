import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  type SQL,
} from "drizzle-orm";
import {
  drizzle,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import {
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import type {
  Pool,
  PoolClient,
} from "pg";

import { createPostgresTestPool } from "../testing/postgres.js";
import { DatabaseManager } from "./database_manager.js";
import { Repository } from "./repository.js";
import type { CursorPagination, CursorPaginationOptions } from "./pagination.js";

const records = pgTable("repository_test_record", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  value: text("value").notNull().unique(),
  category: text("category").default("initial").notNull(),
  createdAt: timestamp("created_at", {
    mode: "date",
    withTimezone: true,
  })
    .defaultNow()
    .notNull(),
});

type RecordRow = typeof records.$inferSelect;
type CreateRecordInput = Pick<
  typeof records.$inferInsert,
  "value"
>;
type UpdateRecordInput = Partial<
  Pick<typeof records.$inferInsert, "category" | "value">
>;
type TestDatabase = NodePgDatabase;
type RecordCursor = Pick<RecordRow, "category" | "id">;

// Repeated categories exercise tie-breaking with mixed sort directions.
const cursorOptions: CursorPaginationOptions<RecordRow, RecordCursor> = {
  orderBy: [asc(records.category), desc(records.id)],
  getCursor: ({ category, id }) => ({ category, id }),
  getCondition: (after) => or(
    gt(records.category, after.category),
    and(eq(records.category, after.category), lt(records.id, after.id)),
  )!,
};

class TestRepository extends Repository<
  typeof records,
  number,
  CreateRecordInput,
  UpdateRecordInput,
  RecordCursor
> {
  public constructor(database: TestDatabase, enableCursor = true) {
    super(new DatabaseManager({ database }), {
      table: records,
      idColumn: records.id,
      orderBy: [records.createdAt, records.id],
      ...(enableCursor ? { cursor: cursorOptions } : {}),
      collection: {
        search: { value: records.value, category: records.category },
        filters: {
          value: {
            column: records.value,
            operators: ["equals", "contains", "starts-with"],
          },
          category: {
            column: records.category,
            operators: ["equals", "not-equals"],
          },
        },
        sorting: { value: records.value, category: records.category },
      },
    });
  }

  /** Exercises keyset composition through the protected filtering extension. */
  public findCategory(category: string, pagination: CursorPagination<RecordCursor>) {
    return this.findAllWhere(eq(records.category, category), pagination);
  }

  /**
   * Exposes the protected bulk-update helper through a query meaningful to
   * this test repository.
   */
  public updateByIds(
    ids: number[],
    input: UpdateRecordInput,
  ): Promise<void> {
    const condition: SQL = inArray(records.id, ids);

    return this.updateAllWhere(condition, input);
  }

  /**
   * Requests updated records for callers that need their persisted values.
   */
  public updateByIdsReturning(
    ids: number[],
    input: UpdateRecordInput,
  ): Promise<RecordRow[]> {
    const condition: SQL = inArray(records.id, ids);

    return this.updateAllWhere(
      condition,
      input,
      { returning: true },
    );
  }
}

let pool: Pool;
let client: PoolClient;
let repository: TestRepository;

beforeAll(async () => {
  pool = createPostgresTestPool();
  client = await pool.connect();

  // A connection-scoped table keeps Kestrel tests independent from the
  // application's schemas and migrations.
  await client.query(`
    CREATE TEMPORARY TABLE repository_test_record (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      value text NOT NULL UNIQUE,
      category text DEFAULT 'initial' NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL
    ) ON COMMIT PRESERVE ROWS
  `);
});

beforeEach(async () => {
  await client.query("BEGIN");
  repository = new TestRepository(drizzle(client));
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

afterAll(async () => {
  client.release();
  await pool.end();
});

describe("Repository", () => {
  it("traverses a mixed-direction composite order without repeating tied records", async () => {
    const database = drizzle(client);
    const inserted = await database.insert(records).values([
      { value: "first-a", category: "a" },
      { value: "first-b", category: "b" },
      { value: "second-a", category: "a" },
      { value: "second-b", category: "b" },
      { value: "third-a", category: "a" },
    ]).returning();

    const first = await repository.findAll({ type: "cursor", pageSize: 2 });
    expectTypeOf(first.pageInfo.nextCursor).toEqualTypeOf<RecordCursor | null>();
    expect(first.items.map((item) => item.value)).toEqual(["third-a", "second-a"]);
    expect(first.pageInfo.nextCursor).toEqual({ category: "a", id: inserted[2]!.id });

    const second = await repository.findAll({
      type: "cursor", pageSize: 2, after: first.pageInfo.nextCursor!,
    });
    expect(second.items.map((item) => item.value)).toEqual(["first-a", "second-b"]);

    const last = await repository.findAll({
      type: "cursor", pageSize: 2, after: second.pageInfo.nextCursor!,
    });
    expect(last.items.map((item) => item.value)).toEqual(["first-b"]);
    expect(last.pageInfo).toEqual({
      type: "cursor", pageSize: 2, hasNextPage: false, nextCursor: null,
    });
  });

  it("keeps filters and resumes after a deleted boundary despite inserts before it", async () => {
    const database = drizzle(client);
    await database.insert(records).values([
      { value: "one", category: "selected" },
      { value: "two", category: "selected" },
      { value: "three", category: "selected" },
      { value: "excluded", category: "z" },
    ]);
    const first = await repository.findCategory("selected", { type: "cursor", pageSize: 1 });
    await database.delete(records).where(eq(records.id, first.items[0]!.id));
    await database.insert(records).values({ value: "new", category: "selected" });

    const next = await repository.findCategory("selected", {
      type: "cursor", pageSize: 2, after: first.pageInfo.nextCursor!,
    });
    expect(next.items.map((item) => item.value)).toEqual(["two", "one"]);
    expect(next.pageInfo).toEqual({
      type: "cursor", pageSize: 2, hasNextPage: false, nextCursor: null,
    });
  });

  it("returns an empty cursor page and rejects repositories without a cursor contract", async () => {
    const empty = await repository.findAll({ type: "cursor", pageSize: 2 });
    expect(empty).toEqual({
      items: [],
      pageInfo: { type: "cursor", pageSize: 2, hasNextPage: false, nextCursor: null },
    });
    const unsupported = new TestRepository(drizzle(client), false);
    await expect(unsupported.findAll({ type: "cursor", pageSize: 2 }))
      .rejects.toThrow("does not support cursor pagination");
  });

  it("creates a record without returning it by default", async () => {
    const result = await repository.create({ value: "created" });
    const found = await repository.findAll();

    expectTypeOf(result).toEqualTypeOf<void>();
    expect(result).toBeUndefined();
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.value).toBe("created");
  });

  it("creates and returns a record when requested", async () => {
    const created = await repository.create(
      { value: "created" },
      { returning: true },
    );
    const found = await repository.findById(created.id);

    expectTypeOf(created).toEqualTypeOf<RecordRow>();
    expectTypeOf(created.id).toEqualTypeOf<number>();
    expect(found).toEqual(created);
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it("finds multiple records by id in deterministic order", async () => {
    const first = await repository.create(
      { value: "first" },
      { returning: true },
    );
    const second = await repository.create(
      { value: "second" },
      { returning: true },
    );

    const found = await repository.findManyByIds([
      second.id,
      first.id,
      2_147_483_647,
    ]);

    expect(found).toEqual([first, second]);
    await expect(repository.findManyByIds([])).resolves.toEqual([]);
  });

  it("lists records in the configured order", async () => {
    await repository.create({ value: "first" });
    await repository.create({ value: "second" });

    const found = await repository.findAll();

    expect(found.items.map((record) => record.value)).toEqual([
      "first",
      "second",
    ]);
    expect(found.pageInfo).toEqual({ type: "all" });
  });

  it("lists numbered pages and reports whether another page exists", async () => {
    for (const value of ["one", "two", "three", "four", "five"]) {
      await repository.create({ value });
    }

    const secondPage = await repository.findAll({
      type: "page",
      page: 2,
      pageSize: 2,
    });
    const lastPage = await repository.findAll({
      type: "page",
      page: 3,
      pageSize: 2,
    });

    expectTypeOf(secondPage.pageInfo.type)
      .toEqualTypeOf<"page">();
    expect(secondPage.items.map((record) => record.value))
      .toEqual(["three", "four"]);
    expect(secondPage.pageInfo).toEqual({
      type: "page",
      page: 2,
      pageSize: 2,
      hasNextPage: true,
    });
    expect(lastPage.items.map((record) => record.value))
      .toEqual(["five"]);
    expect(lastPage.pageInfo.hasNextPage).toBe(false);
  });

  it("applies allowlisted collection search, filters and sorting", async () => {
    const first = await repository.create(
      { value: "Alpha" },
      { returning: true },
    );
    await repository.create({ value: "Beta" });
    await repository.create({ value: "Alphabet" });
    await repository.update(first.id, { category: "selected" });

    const found = await repository.findCollection({
      pagination: { type: "page", page: 1, pageSize: 10 },
      search: { term: "ALPHA" },
      filters: [{
        field: "category",
        operator: "equals",
        value: "selected",
      }],
      sort: [{ field: "value", direction: "desc" }],
    });

    expect(found.items.map((record) => record.value)).toEqual(["Alpha"]);
  });

  it("rejects collection criteria outside the repository allowlist", async () => {
    await expect(repository.findCollection({
      pagination: { type: "page", page: 1, pageSize: 10 },
      filters: [{ field: "id", operator: "equals", value: 1 }],
    })).rejects.toThrow('Collection filter "id.equals" is not supported.');
  });

  it("updates a record without returning it by default", async () => {
    const created = await repository.create(
      { value: "before" },
      { returning: true },
    );

    const result = await repository.update(created.id, {
      value: "after",
    });

    expectTypeOf(result).toEqualTypeOf<void>();
    expect(result).toBeUndefined();
    await expect(repository.findById(created.id)).resolves.toMatchObject({
      id: created.id,
      value: "after",
    });
  });

  it("returns an updated record when requested", async () => {
    const created = await repository.create(
      { value: "before" },
      { returning: true },
    );

    const updated = await repository.update(
      created.id,
      { value: "after" },
      { returning: true },
    );

    expectTypeOf(updated).toEqualTypeOf<RecordRow | null>();
    expect(updated).toMatchObject({
      id: created.id,
      value: "after",
    });
  });

  it("updates matching records without returning them by default", async () => {
    const first = await repository.create(
      { value: "first" },
      { returning: true },
    );
    const second = await repository.create(
      { value: "second" },
      { returning: true },
    );
    const untouched = await repository.create(
      { value: "untouched" },
      { returning: true },
    );

    const result = await repository.updateByIds(
      [first.id, second.id],
      { category: "updated" },
    );

    expectTypeOf(result).toEqualTypeOf<void>();
    expect(result).toBeUndefined();
    await expect(repository.findById(first.id)).resolves.toMatchObject(
      { category: "updated" },
    );
    await expect(repository.findById(second.id)).resolves.toMatchObject(
      { category: "updated" },
    );
    await expect(repository.findById(untouched.id)).resolves.toEqual(
      untouched,
    );
  });

  it("returns updated records when requested", async () => {
    const first = await repository.create(
      { value: "first" },
      { returning: true },
    );
    const second = await repository.create(
      { value: "second" },
      { returning: true },
    );

    const updated = await repository.updateByIdsReturning(
      [first.id, second.id],
      { category: "updated" },
    );

    expectTypeOf(updated).toEqualTypeOf<RecordRow[]>();
    expect(updated).toHaveLength(2);
    expect(updated.map((record) => record.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    expect(updated.every((record) => record.category === "updated"))
      .toBe(true);
  });

  it("returns an empty list when no records match a returning update", async () => {
    const updated = await repository.updateByIdsReturning(
      [2_147_483_647],
      { category: "missing" },
    );

    expect(updated).toEqual([]);
  });

  it("deletes a record without returning it by default", async () => {
    const created = await repository.create(
      { value: "deleted" },
      { returning: true },
    );

    const result = await repository.delete(created.id);

    expectTypeOf(result).toEqualTypeOf<void>();
    expect(result).toBeUndefined();
    await expect(
      repository.findById(created.id),
    ).resolves.toBeNull();
  });

  it("returns a deleted record when requested", async () => {
    const created = await repository.create(
      { value: "deleted" },
      { returning: true },
    );

    const deleted = await repository.delete(
      created.id,
      { returning: true },
    );

    expectTypeOf(deleted).toEqualTypeOf<RecordRow | null>();
    expect(deleted?.id).toBe(created.id);
  });

  it("returns null when a record does not exist", async () => {
    const missingId = 2_147_483_647;

    await expect(
      repository.findById(missingId),
    ).resolves.toBeNull();
    await expect(
      repository.update(
        missingId,
        { value: "missing" },
        { returning: true },
      ),
    ).resolves.toBeNull();
    await expect(
      repository.delete(missingId, { returning: true }),
    ).resolves.toBeNull();
  });

  it("propagates database errors", async () => {
    await repository.create({ value: "unique" });

    await expect(
      repository.create({ value: "unique" }),
    ).rejects.toMatchObject({
      cause: {
        code: "23505",
      },
    });
  });
});
