import { and, type SQL } from "drizzle-orm";
import type { PgColumn, PgSelect } from "drizzle-orm/pg-core";

export interface AllPagination {
  type: "all";
}

export interface PagePagination {
  type: "page";
  page: number;
  pageSize: number;
}

/** A forward-only keyset request. Omit `after` to start a new traversal. */
export interface CursorPagination<Cursor = unknown> {
  type: "cursor";
  pageSize: number;
  after?: Cursor;
}

/** Keeps SQL ordering, cursor extraction and the exclusive boundary together. */
export interface CursorPaginationOptions<Item, Cursor> {
  /** Must describe a total order ending with a unique tie-breaker. */
  orderBy: readonly [
    PgColumn | SQL | SQL.Aliased,
    ...(PgColumn | SQL | SQL.Aliased)[],
  ];
  /** Preserve the database precision of every ordered value. */
  getCursor: (item: Item) => Cursor;
  /** Return the exclusive keyset predicate in the configured order. */
  getCondition: (after: Cursor) => SQL;
}

export type Pagination<Cursor = unknown> =
  | AllPagination
  | PagePagination
  | CursorPagination<Cursor>;

export interface AllPageInfo {
  type: "all";
}

export interface NumberedPageInfo {
  type: "page";
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

export interface CursorPageInfo<Cursor = unknown> {
  type: "cursor";
  pageSize: number;
  hasNextPage: boolean;
  /** Null when no further page exists. Never points to the lookahead item. */
  nextCursor: Cursor | null;
}

export type PageInfo<
  Strategy extends Pagination,
  Cursor = Strategy extends CursorPagination<infer Value> ? Value : never,
> =
  Strategy extends AllPagination
    ? AllPageInfo
    : Strategy extends CursorPagination
      ? CursorPageInfo<Cursor>
      : NumberedPageInfo;

/** Distribute strategies so numbered results stay independent of cursor types. */
export type PaginatedResult<
  Item,
  Strategy extends Pagination,
  Cursor = Strategy extends CursorPagination<infer Value> ? Value : never,
> = Strategy extends Pagination ? {
  items: Item[];
  pageInfo: PageInfo<Strategy, Cursor>;
} : never;

export interface PaginationQueryWindow {
  limit: number;
  offset?: number;
}

/** Combines the cursor boundary with filters without replacing either one. */
export function getCursorPaginationCondition<Item, Cursor>(
  pagination: CursorPagination<Cursor>,
  options: CursorPaginationOptions<Item, Cursor>,
  condition?: SQL,
): SQL | undefined {
  assertCursorPagination(pagination);

  return pagination.after === undefined
    ? condition
    : and(condition, options.getCondition(pagination.after));
}

/**
 * Returns the fetch window. Cursor queries have a limit but no offset.
 *
 * One extra item is requested so `createPaginatedResult` can determine whether
 * another page exists. Unbounded queries do not need a window.
 */
export function getPaginationQueryWindow(
  pagination: Pagination,
): PaginationQueryWindow | null {
  if (pagination.type === "all") {
    return null;
  }

  if (pagination.type === "cursor") {
    assertCursorPagination(pagination);
    return { limit: pagination.pageSize + 1 };
  }

  return {
    limit: pagination.pageSize + 1,
    offset:
      (pagination.page - 1) * pagination.pageSize,
  };
}

/**
 * Builds the shared collection result from records fetched for a strategy.
 */
export function createPaginatedResult<
  Item,
  const Strategy extends Pagination,
  Cursor = Strategy extends CursorPagination<infer Value> ? Value : never,
>(
  records: Item[],
  pagination: Strategy,
  getCursor?: (item: Item) => Cursor,
): PaginatedResult<Item, Strategy, Cursor> {
  if (pagination.type === "all") {
    return {
      items: records,
      pageInfo: { type: "all" },
    } as PaginatedResult<Item, Strategy, Cursor>;
  }

  if (pagination.type === "cursor") {
    assertCursorPagination(pagination);
    if (getCursor === undefined) {
      throw new TypeError("Cursor pagination requires a cursor extractor.");
    }

    const items = records.slice(0, pagination.pageSize);
    const hasNextPage = records.length > pagination.pageSize;
    // A positive page size guarantees a last item when lookahead exists.
    const nextCursor = hasNextPage ? getCursor(items[items.length - 1]!) : null;
    if (hasNextPage && nextCursor == null) {
      throw new TypeError("A cursor extractor must return a non-null cursor.");
    }

    return {
      items,
      pageInfo: {
        type: "cursor",
        pageSize: pagination.pageSize,
        hasNextPage,
        nextCursor,
      },
    } as PaginatedResult<Item, Strategy, Cursor>;
  }

  const hasNextPage = records.length > pagination.pageSize;

  return {
    items: records.slice(0, pagination.pageSize),
    pageInfo: {
      type: "page",
      page: pagination.page,
      pageSize: pagination.pageSize,
      hasNextPage,
    },
  } as PaginatedResult<Item, Strategy, Cursor>;
}

/**
 * Applies the shared pagination behavior to an ordered query.
 *
 * Execution remains the caller's responsibility. This allows callers to add
 * query-specific behavior before executing, and keeps query composition
 * separate from result formatting.
 * Cursor callers must first apply `getCursorPaginationCondition()` and the
 * matching `CursorPaginationOptions.orderBy`; this helper only sets the window.
 */
export function paginateQuery<
  Query extends PgSelect,
  const Strategy extends Pagination,
>(
  query: Query,
  pagination: Strategy,
): Query {
  const window = getPaginationQueryWindow(pagination);

  if (window === null) {
    return query;
  }

  const limitedQuery = query.limit(window.limit);
  return window.offset === undefined
    ? limitedQuery
    : limitedQuery.offset(window.offset);
}

/** Validate before SQL execution, including calls that bypass action schemas. */
function assertCursorPagination(pagination: CursorPagination): void {
  if (
    !Number.isSafeInteger(pagination.pageSize)
    || pagination.pageSize < 1
    || pagination.pageSize >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(
      "The cursor page size must be a positive safe integer with room for lookahead.",
    );
  }
  if (pagination.after === null) {
    throw new TypeError(
      "Omit the cursor to start a traversal; null is not a valid cursor.",
    );
  }
}
