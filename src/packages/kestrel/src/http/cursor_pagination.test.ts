import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createCursorPaginatedOutputSchema,
  createCursorPaginationInputSchema,
  createPaginationCursorCodec,
  defineAction,
  mapCursorPaginationInput,
} from "../actions/index.js";
import { App } from "../app/index.js";
import { createPaginatedResult, type CursorPagination } from "../db/index.js";
import { testHttpAccess } from "../testing/http_access.js";
import { defineActionHttpController, get, HttpControllerManager } from "./index.js";

it("maps URL cursors to database pagination and returns reusable continuation tokens", async () => {
  const codec = createPaginationCursorCodec(z.object({ id: z.number().int() }));
  const sizes = { defaultPageSize: 2, maxPageSize: 3 };
  // A small ordered collection exercises the DB result helper without a server or pool.
  const find = vi.fn((pagination: CursorPagination<{ id: number }>) => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]
      .filter((row) => row.id > (pagination.after?.id ?? 0))
      .slice(0, pagination.pageSize + 1);
    return createPaginatedResult(rows, pagination, ({ id }) => ({ id }));
  });
  const action = defineAction({
    name: "record.list",
    input: z.object({ category: z.string(), pagination: createCursorPaginationInputSchema(codec, sizes) }),
    output: createCursorPaginatedOutputSchema(z.object({ id: z.number().int() }), codec),
    handler: ({ pagination }) => find(pagination),
  }).derive(mapCursorPaginationInput(codec, sizes));
  const app = new App({});
  const server = Fastify();
  server.addHook("onReady", async () => app.start());
  try {
    const manager = new HttpControllerManager(app, server);
    manager.register(defineActionHttpController(action, get("/records"), testHttpAccess));
    const first = await server.inject({ method: "GET", url: "/records?category=selected" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ items: [{ id: 1 }, { id: 2 }], pageInfo: {
      type: "cursor", pageSize: 2, hasNextPage: true, nextCursor: z.encode(codec, { id: 2 }),
    } });
    const query = new URLSearchParams({ category: "selected", pageSize: "2", after: first.json().pageInfo.nextCursor });
    const next = await server.inject({ method: "GET", url: `/records?${query}` });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toEqual({ items: [{ id: 3 }], pageInfo: {
      type: "cursor", pageSize: 2, hasNextPage: false, nextCursor: null,
    } });
    expect(find).toHaveBeenLastCalledWith({ type: "cursor", pageSize: 2, after: { id: 2 } });

    for (const suffix of ["after=invalid", "after=", "pageSize=4", "pageSize=0", "after=x&after=y", "pageSize=2&pageSize=3"]) {
      const invalid = await server.inject({ method: "GET", url: `/records?category=selected&${suffix}` });
      expect(invalid.statusCode).toBe(400);
    }
    expect(find).toHaveBeenCalledTimes(2);
  } finally {
    await server.close();
    await app.dispose();
  }
});
