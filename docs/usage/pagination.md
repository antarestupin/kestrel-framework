# Pagination

[Usage index](./README.md) · [Implementation and repository contracts](../implementation/pagination.md)

Collection reads return `{ items, pageInfo }`. Use numbered pages for ordinary lists and forward cursors for ordered traversal. An unbounded `all` read should be an explicit application decision.

## Validate numbered pages

Use numbered pagination for lists whose callers select a page and page size. Validate and bound those values before passing them to the repository.

```ts
import { createPaginationInputSchema, paginationControllerInputSchema, mapPaginationControllerInput } from "@kestrel/framework/actions";

const inputSchema = createPaginationInputSchema({
  defaultPageSize: 20,
  // Bound caller-selected page sizes before querying storage.
  maxPageSize: 100,
});
const pagination = inputSchema.parse({ type: "page", page: 2, pageSize: 20 });

// Controllers receive strings; the transport helper coerces and maps them.
const fields = paginationControllerInputSchema.parse({ page: "2", pageSize: "20" });
const mapped = mapPaginationControllerInput(fields);
```

Pass a validated pagination value to `repository.findAll(pagination)`. Without an argument, `findAll()` selects `all`; public model-list actions instead default to the first bounded page. `pageInfo.hasNextPage` avoids an implicit count query; totals are not returned by default.

For conventional CRUD, compose `defineModelListAction` with `defineModelListActionHttpController` or `defineModelListActionCliController`. For an existing action accepting `{ pagination, ...filters }`, `action.derive(mapPaginationInput)` exposes flat `page` and `pageSize` fields while retaining filters.

## Encode and consume a forward cursor

Use cursor pagination when a caller continues an ordered traversal from the last record it received. The transport carries an opaque token that the server decodes and validates.

```ts
import { z } from "zod";
import { createPaginationCursorCodec, createCursorPaginationControllerInputSchema, mapCursorPaginationControllerInput } from "@kestrel/framework/actions";

const cursorCodec = createPaginationCursorCodec(z.object({ id: z.uuid() }));
const pageSizes = { defaultPageSize: 20, maxPageSize: 100 };
const querySchema = createCursorPaginationControllerInputSchema(cursorCodec, pageSizes);
// Encode the last record's position for a subsequent request.
const token = z.encode(cursorCodec, { id: "01900000-0000-7000-8000-000000000001" });
const query = querySchema.parse({ after: token, pageSize: "20" });
const { pagination: cursorPagination } = mapCursorPaginationControllerInput(cursorCodec, query);
// Pass cursorPagination to a repository configured for this exact cursor shape.
```

The first request omits `after`; the next supplies the returned `pageInfo.nextCursor`. A null next cursor ends traversal. For actions, pair `createCursorPaginationInputSchema` with `createCursorPaginatedOutputSchema`, then derive the controller action using `mapCursorPaginationInput(codec, pageSizes)`.

## Configure repository ordering

Define cursor ordering when connecting pagination to a repository. The example uses the unique record ID for both sorting and selecting records after the previous page.

```ts
import { asc, gt } from "drizzle-orm";
import { pgTable, uuid } from "drizzle-orm/pg-core";
import type { RepositoryOptions } from "@kestrel/framework/db";

const records = pgTable("record", { id: uuid("id").primaryKey() });
const options: RepositoryOptions<typeof records, string, { id: string }> = {
  table: records,
  idColumn: records.id,
  orderBy: [asc(records.id)],
  cursor: {
    orderBy: [asc(records.id)],
    getCursor: (record) => ({ id: record.id }),
    // Continue strictly after the cursor in the same ascending order.
    getCondition: (cursor) => gt(records.id, cursor.id),
  },
};
```

Supply these options to a [repository](./database.md#create-a-repository-backed-action), declaring `{ id: string }` as its fifth type argument. Ordering and the continuation condition must agree and include a unique tie-breaker. Preserve database precision when using timestamps or large integers in cursors.

Cursor tokens are encoded, not signed or encrypted. Keep authorization filters and sort context stable across requests, and validate any context encoded in a cursor. See the [detailed cursor contract](../implementation/pagination.md#cursor-pagination) for custom queries and precision handling.

## Use cases still to document

- Connect an HTTP controller, action and repository for numbered and cursor pagination.
- Encode composite cursors with timestamp or bigint fields.
- Paginate a filtered custom query.
- Enable an explicitly authorized unpaginated read with allowAll.
