import {
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import {
  createPaginatedResult,
  getCursorPaginationCondition,
  getPaginationQueryWindow,
  paginateQuery,
} from "./pagination.js";
import { asc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import type { PgSelect } from "drizzle-orm/pg-core";

describe("database pagination helpers", () => {
  it("uses keyset predicates with existing filters and no offset", () => {
    const records = pgTable("record", {
      id: integer("id").primaryKey(),
      category: text("category").notNull(),
    });
    const options = {
      orderBy: [asc(records.id)] as const,
      getCursor: (item: { id: number }) => item.id,
      getCondition: (after: number) => gt(records.id, after),
    };
    const pagination = { type: "cursor", pageSize: 2, after: 10 } as const;
    const condition = getCursorPaginationCondition(
      pagination, options, eq(records.category, "selected"),
    );
    const query = paginateQuery(
      drizzle.mock().select().from(records).where(condition).orderBy(...options.orderBy).$dynamic(),
      pagination,
    ).toSQL();

    expect(query.sql).toContain('("record"."category" = $1 and "record"."id" > $2)');
    expect(query.sql).toContain('order by "record"."id" asc limit $3');
    expect(query.sql).not.toContain("offset");
    expect(query.params).toEqual(["selected", 10, 3]);
    expect(getPaginationQueryWindow(pagination)).toEqual({ limit: 3 });
  });

  it("derives the next cursor from the last returned item, not the lookahead", () => {
    const getCursor = vi.fn((item: { id: number }) => ({ id: item.id }));
    const result = createPaginatedResult(
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      { type: "cursor", pageSize: 2 },
      getCursor,
    );

    expectTypeOf(result.pageInfo.nextCursor).toEqualTypeOf<{ id: number } | null>();
    expectTypeOf(result.pageInfo.type).toEqualTypeOf<"cursor">();
    expect(result).toEqual({
      items: [{ id: 1 }, { id: 2 }],
      pageInfo: { type: "cursor", pageSize: 2, hasNextPage: true, nextCursor: { id: 2 } },
    });
    expect(getCursor).toHaveBeenCalledExactlyOnceWith({ id: 2 });
  });

  it.each([{ records: [] }, { records: [1] }, { records: [1, 2] }])(
    "ends a traversal without lookahead: $records", ({ records }) => {
      const getCursor = vi.fn((item: number) => item);
      const result = createPaginatedResult(records, { type: "cursor", pageSize: 2 }, getCursor);

      expect(result.items).toEqual(records);
      expect(result.pageInfo).toEqual({
        type: "cursor", pageSize: 2, hasNextPage: false, nextCursor: null,
      });
      expect(getCursor).not.toHaveBeenCalled();
    },
  );

  it("distinguishes a missing cursor from a zero-valued cursor", () => {
    const records = pgTable("record", { id: integer("id").primaryKey() });
    const getCondition = vi.fn((after: number) => gt(records.id, after));
    const options = {
      orderBy: [records.id] as const,
      getCursor: (item: number) => item,
      getCondition,
    };
    const filter = gt(records.id, -10);
    expect(getCursorPaginationCondition({ type: "cursor", pageSize: 1 }, options, filter))
      .toBe(filter);
    expect(getCondition).not.toHaveBeenCalled();

    getCursorPaginationCondition({ type: "cursor", pageSize: 1, after: 0 }, options);
    expect(getCondition).toHaveBeenCalledExactlyOnceWith(0);
    expect(createPaginatedResult([0, 1], { type: "cursor", pageSize: 1 }, options.getCursor)
      .pageInfo.nextCursor).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects invalid cursor page size %s", (pageSize) => {
      expect(() => getPaginationQueryWindow({ type: "cursor", pageSize })).toThrow(TypeError);
    },
  );

  it("requires a non-null cursor extractor and rejects null input cursors", () => {
    expect(() => createPaginatedResult([], { type: "cursor", pageSize: 2 }))
      .toThrow("cursor extractor");
    expect(() => createPaginatedResult([1, 2], { type: "cursor", pageSize: 1 }, () => null))
      .toThrow("non-null cursor");
    expect(() => getPaginationQueryWindow({ type: "cursor", pageSize: 2, after: null }))
      .toThrow("null is not a valid cursor");
  });

  it("does not create a query window for an all-record strategy", () => {
    expect(
      getPaginationQueryWindow({ type: "all" }),
    ).toBeNull();
  });

  it("creates a query window with one extra record", () => {
    expect(
      getPaginationQueryWindow({
        type: "page",
        page: 3,
        pageSize: 10,
      }),
    ).toEqual({
      limit: 11,
      offset: 20,
    });
  });

  it("builds a numbered result and removes the extra record", () => {
    const result = createPaginatedResult(
      ["three", "four", "five"],
      {
        type: "page",
        page: 2,
        pageSize: 2,
      },
    );

    expectTypeOf(result.pageInfo.type)
      .toEqualTypeOf<"page">();
    expect(result).toEqual({
      items: ["three", "four"],
      pageInfo: {
        type: "page",
        page: 2,
        pageSize: 2,
        hasNextPage: true,
      },
    });
  });

  it("applies pagination to arbitrary ordered queries without executing them", async () => {
    const executePage = vi.fn(async () => [
      "three",
      "four",
      "five",
    ]);
    const offset = vi.fn(() => ({
      execute: executePage,
    }));
    const limit = vi.fn(() => ({ offset }));
    const executeAll = vi.fn(async () => [
      "one",
      "two",
      "three",
      "four",
      "five",
    ]);
    const query = {
      execute: executeAll,
      limit,
    } as unknown as PgSelect & {
      execute(): Promise<string[]>;
    };

    const paginatedQuery = paginateQuery(query, {
      type: "page",
      page: 2,
      pageSize: 2,
    });

    expect(limit).toHaveBeenCalledWith(3);
    expect(offset).toHaveBeenCalledWith(2);
    expect(executePage).not.toHaveBeenCalled();
    expect(executeAll).not.toHaveBeenCalled();

    const records = await paginatedQuery.execute();
    const result = createPaginatedResult(records, {
      type: "page",
      page: 2,
      pageSize: 2,
    });

    expect(executePage).toHaveBeenCalledOnce();
    expect(result.items).toEqual(["three", "four"]);
    expect(result.pageInfo.hasNextPage).toBe(true);
  });
});
