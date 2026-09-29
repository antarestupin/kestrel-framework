import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import type {
  AnyPgColumn,
  AnyPgTable,
  PgColumn,
} from "drizzle-orm/pg-core";
import type { PgInsertValue } from "drizzle-orm/pg-core/query-builders/insert";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core/query-builders/update";

import {
  type CollectionFilter,
  type CollectionQuery,
  type RepositoryCollectionOptions,
} from "./collection.js";
import {
  type AllPagination,
  type CursorPaginationOptions,
  type PaginatedResult,
  type Pagination,
  createPaginatedResult,
  getCursorPaginationCondition,
  paginateQuery,
} from "./pagination.js";
import {
  type DatabaseExecutor,
  DatabaseManager,
} from "./database_manager.js";

export interface RepositoryOptions<
  Table extends AnyPgTable,
  Id,
  Cursor = unknown,
> {
  table: Table;
  idColumn: AnyPgColumn<{ data: Id }>;
  orderBy: readonly [
    PgColumn | SQL | SQL.Aliased,
    ...(PgColumn | SQL | SQL.Aliased)[],
  ];
  /** Explicitly allowlists fields accepted by collection queries. */
  collection?: RepositoryCollectionOptions;
  /** Explicit keyset contract, independent from numbered collection sorting. */
  cursor?: CursorPaginationOptions<Table["$inferSelect"], Cursor>;
}

export interface RepositoryReturningOptions<
  Returning extends boolean = false,
> {
  returning?: Returning;
}

type RepositoryReturningResult<
  Value,
  Returning extends boolean,
> = Returning extends true
  ? Value
  : void;

/**
 * Provides the CRUD operations shared by PostgreSQL repositories.
 *
 * Concrete repositories define their public input types and may customize the
 * values written during an update through `getUpdateValues`.
 */
export abstract class Repository<
  Table extends AnyPgTable,
  Id,
  CreateInput extends PgInsertValue<Table>,
  UpdateInput extends PgUpdateSetSource<Table>,
  Cursor = unknown,
> {
  protected constructor(
    private readonly databaseManager: DatabaseManager,
    protected readonly options: RepositoryOptions<Table, Id, Cursor>,
  ) {}

  /**
   * Resolves the executor for every query so ambient transactions are honored.
   */
  protected get database(): DatabaseExecutor {
    return this.databaseManager.database;
  }

  /**
   * Creates one record. The persisted record is only returned when explicitly
   * requested.
   */
  public async create<
    const Returning extends boolean = false,
  >(
    input: CreateInput,
    options: RepositoryReturningOptions<Returning> = {},
  ): Promise<
    RepositoryReturningResult<
      Table["$inferSelect"],
      Returning
    >
  > {
    const query = this.database
      .insert(this.options.table)
      .values(input);

    if (options.returning !== true) {
      await query;

      return undefined as RepositoryReturningResult<
        Table["$inferSelect"],
        Returning
      >;
    }

    const [record] = await query.returning();

    if (record === undefined) {
      throw new Error(
        "The repository create operation did not return a record.",
      );
    }

    return record as RepositoryReturningResult<
      Table["$inferSelect"],
      Returning
    >;
  }

  public async findById(
    id: Id,
  ): Promise<Table["$inferSelect"] | null> {
    const [record] = await this.database
      .select()
      // Drizzle cannot resolve its empty-selection conditional for a generic
      // table even though repositories only accept tables with columns.
      .from(this.options.table as never)
      .where(eq(this.options.idColumn, id))
      .limit(1);

    return (record as Table["$inferSelect"] | undefined) ?? null;
  }

  /**
   * Finds multiple records by identifier in the repository's deterministic
   * order. Missing identifiers are omitted from the result.
   */
  public async findManyByIds(
    ids: readonly Id[],
  ): Promise<Table["$inferSelect"][]> {
    if (ids.length === 0) {
      return [];
    }

    const records = await this.database
      .select()
      // See the generic-table note in `findById`.
      .from(this.options.table as never)
      .where(inArray(this.options.idColumn, [...ids]))
      .orderBy(...this.options.orderBy);

    return records as Table["$inferSelect"][];
  }

  public async findAll<
    const Strategy extends Pagination<Cursor> = AllPagination,
  >(
    pagination?: Strategy,
  ): Promise<
    PaginatedResult<
      Table["$inferSelect"],
      Strategy,
      Cursor
    >
  > {
    return this.findAllWhere(undefined, pagination);
  }

  /** Applies a validated application collection query to this repository. */
  public async findCollection(
    query: CollectionQuery,
  ): Promise<PaginatedResult<Table["$inferSelect"], typeof query.pagination>> {
    const condition = this.compileCollectionCondition(query);
    const orderBy = this.compileCollectionSorting(query);

    return this.findAllWhere(condition, query.pagination, orderBy);
  }

  /**
   * Applies the repository's deterministic ordering and pagination to a
   * filtered query so specialized repositories only need to define the filter.
   */
  protected async findAllWhere<
    const Strategy extends Pagination<Cursor> = AllPagination,
  >(
    condition: SQL | undefined,
    pagination?: Strategy,
    orderBy: RepositoryOptions<Table, Id, Cursor>["orderBy"]
      | readonly (PgColumn | SQL | SQL.Aliased)[] = this.options.orderBy,
  ): Promise<
    PaginatedResult<
      Table["$inferSelect"],
      Strategy,
      Cursor
    >
  > {
    const resolvedPagination = (
      pagination ?? { type: "all" as const }
    ) as Strategy;
    const cursor = this.options.cursor;
    if (resolvedPagination.type === "cursor") {
      if (cursor === undefined) {
        throw new TypeError("This repository does not support cursor pagination.");
      }
      if (orderBy !== this.options.orderBy) {
        throw new TypeError("Cursor pagination must use its configured ordering.");
      }
      // Compose filters before building the query so neither WHERE is lost.
      condition = getCursorPaginationCondition(resolvedPagination, cursor, condition);
      orderBy = cursor.orderBy;
    }
    const query = this.database
      .select()
      // See the generic-table note in `findById`.
      .from(this.options.table as never)
      .where(condition)
      .orderBy(...orderBy);

    // Use Drizzle's dynamic mode because pagination conditionally adds clauses.
    const paginatedQuery = paginateQuery(
      query.$dynamic(),
      resolvedPagination,
    );

    const records = await paginatedQuery.execute();

    return createPaginatedResult(records, resolvedPagination, cursor?.getCursor);
  }

  private compileCollectionCondition(query: CollectionQuery): SQL | undefined {
    const collection = this.options.collection;
    const conditions: SQL[] = [];

    if (query.search !== undefined && query.search.term !== "") {
      const columns = Object.values(collection?.search ?? {})
        .map((column) => asColumn(column, "search"));
      if (columns.length === 0) {
        throw new TypeError("This repository does not support collection search.");
      }

      const pattern = `%${escapeLikePattern(query.search.term)}%`;
      const search = or(...columns.map((column) => ilike(column, pattern)));
      if (search !== undefined) {
        conditions.push(search);
      }
    }

    for (const filter of query.filters ?? []) {
      const definition = collection?.filters?.[filter.field];
      if (definition === undefined || !definition.operators.includes(filter.operator)) {
        throw new TypeError(
          `Collection filter "${filter.field}.${filter.operator}" is not supported.`,
        );
      }

      conditions.push(compileCollectionFilter(
        asColumn(definition.column, `filter "${filter.field}"`),
        filter,
      ));
    }

    return and(...conditions);
  }

  private compileCollectionSorting(
    query: CollectionQuery,
  ): readonly (PgColumn | SQL | SQL.Aliased)[] {
    if (query.sort === undefined || query.sort.length === 0) {
      return this.options.orderBy;
    }

    return query.sort.map((criterion) => {
      const configuredColumn = this.options.collection?.sorting?.[criterion.field];
      const column = asColumn(configuredColumn, `sorting "${criterion.field}"`);

      return criterion.direction === "asc" ? asc(column) : desc(column);
    });
  }

  /**
   * Updates one record by identifier. The persisted record is only returned
   * when explicitly requested.
   */
  public async update<
    const Returning extends boolean = false,
  >(
    id: Id,
    input: UpdateInput,
    options: RepositoryReturningOptions<Returning> = {},
  ): Promise<
    RepositoryReturningResult<
      Table["$inferSelect"] | null,
      Returning
    >
  > {
    const query = this.database
      .update(this.options.table)
      .set(this.getUpdateValues(input))
      .where(eq(this.options.idColumn, id));

    if (options.returning === true) {
      const records = await query.returning();
      const [record] = records as Table["$inferSelect"][];

      return (record ?? null) as RepositoryReturningResult<
        Table["$inferSelect"] | null,
        Returning
      >;
    }

    await query;

    return undefined as RepositoryReturningResult<
      Table["$inferSelect"] | null,
      Returning
    >;
  }

  /**
   * Updates every record matching the supplied condition. Updated records
   * are only returned when explicitly requested to avoid an unnecessary
   * PostgreSQL RETURNING clause.
   */
  protected async updateAllWhere<
    const Returning extends boolean = false,
  >(
    condition: SQL | undefined,
    input: UpdateInput,
    options: RepositoryReturningOptions<Returning> = {},
  ): Promise<
    RepositoryReturningResult<
      Table["$inferSelect"][],
      Returning
    >
  > {
    const query = this.database
      .update(this.options.table)
      .set(this.getUpdateValues(input))
      .where(condition);

    if (options.returning === true) {
      const records = await query.returning();

      // Drizzle cannot resolve the returned selection for a generic table,
      // while the true option guarantees that this branch returns its rows.
      return records as unknown as RepositoryReturningResult<
        Table["$inferSelect"][],
        Returning
      >;
    }

    await query;

    return undefined as RepositoryReturningResult<
      Table["$inferSelect"][],
      Returning
    >;
  }

  /**
   * Deletes one record by identifier. The deleted record is only returned
   * when explicitly requested.
   */
  public async delete<
    const Returning extends boolean = false,
  >(
    id: Id,
    options: RepositoryReturningOptions<Returning> = {},
  ): Promise<
    RepositoryReturningResult<
      Table["$inferSelect"] | null,
      Returning
    >
  > {
    const query = this.database
      .delete(this.options.table)
      .where(eq(this.options.idColumn, id));

    if (options.returning === true) {
      const records = await query.returning();
      const [record] = records as Table["$inferSelect"][];

      return (record ?? null) as RepositoryReturningResult<
        Table["$inferSelect"] | null,
        Returning
      >;
    }

    await query;

    return undefined as RepositoryReturningResult<
      Table["$inferSelect"] | null,
      Returning
    >;
  }

  /**
   * Converts a repository update input into values accepted by Drizzle.
   */
  protected getUpdateValues(
    input: UpdateInput,
  ): PgUpdateSetSource<Table> {
    return input;
  }
}

function asColumn(value: unknown, context: string): PgColumn {
  if (value === undefined || value === null) {
    throw new TypeError(`This repository does not support ${context}.`);
  }

  // Repository collection configuration accepts Drizzle columns but keeps the
  // public options independent from Drizzle's deeply generic column types.
  return value as PgColumn;
}

function compileCollectionFilter(
  column: PgColumn,
  filter: CollectionFilter,
): SQL {
  const value = normalizeColumnValue(column, filter.value);

  switch (filter.operator) {
    case "contains":
      return ilike(column, `%${escapeLikePattern(requireString(filter))}%`);
    case "starts-with":
      return ilike(column, `${escapeLikePattern(requireString(filter))}%`);
    case "equals":
      return eq(column, value as never);
    case "not-equals":
      return ne(column, value as never);
    case "greater-than":
      return gt(column, value as never);
    case "greater-than-or-equal":
      return gte(column, value as never);
    case "less-than":
      return lt(column, value as never);
    case "less-than-or-equal":
      return lte(column, value as never);
    case "in":
      return inArray(
        column,
        requireArray(filter).map(
          (item) => normalizeColumnValue(column, item),
        ) as never[],
      );
    case "not-in":
      return notInArray(
        column,
        requireArray(filter).map(
          (item) => normalizeColumnValue(column, item),
        ) as never[],
      );
    case "is-null":
      return isNull(column);
    case "is-not-null":
      return isNotNull(column);
  }
}

function normalizeColumnValue(column: PgColumn, value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  if (column.dataType === "number") {
    const number = Number(value);

    return Number.isNaN(number) ? value : number;
  }

  if (column.dataType === "boolean") {
    return value === "true" ? true : value === "false" ? false : value;
  }

  if (
    column.dataType === "date"
    && !column.columnType.endsWith("String")
  ) {
    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? value : date;
  }

  return value;
}

function requireString(filter: CollectionFilter): string {
  if (typeof filter.value !== "string") {
    throw new TypeError(
      `Collection filter "${filter.field}.${filter.operator}" requires a string value.`,
    );
  }

  return filter.value;
}

function requireArray(filter: CollectionFilter): readonly unknown[] {
  if (!Array.isArray(filter.value) || filter.value.length === 0) {
    throw new TypeError(
      `Collection filter "${filter.field}.${filter.operator}" requires a non-empty array value.`,
    );
  }

  return filter.value;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}
