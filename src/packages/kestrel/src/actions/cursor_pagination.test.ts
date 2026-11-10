import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { App } from "../app/index.js";
import type { CursorPagination } from "../db/index.js";
import {
  createCursorPaginatedOutputSchema,
  createCursorPaginationControllerInputSchema,
  createCursorPaginationInputSchema,
  createPaginationCursorCodec,
  defineAction,
  mapCursorPaginationControllerInput,
  mapCursorPaginationInput,
} from "./index.js";

const cursorSchema = z.object({ id: z.number().int(), label: z.string() });
const cursorCodec = createPaginationCursorCodec(cursorSchema);

describe("cursor pagination contracts", () => {
  it("maps URL parameters to a bounded structured database request", () => {
    const schema = createCursorPaginationControllerInputSchema(cursorCodec, { defaultPageSize: 5, maxPageSize: 10 });
    expect(mapCursorPaginationControllerInput(cursorCodec, schema.parse({}))).toEqual({
      pagination: { type: "cursor", pageSize: 5 },
    });
    const after = { id: 2, label: "second" };
    const params = new URLSearchParams({ after: z.encode(cursorCodec, after), pageSize: "3" });
    const result = mapCursorPaginationControllerInput(cursorCodec, schema.parse(Object.fromEntries(params)));
    expect(result).toEqual({ pagination: { type: "cursor", pageSize: 3, after } });
    expectTypeOf(result.pagination).toEqualTypeOf<CursorPagination<z.output<typeof cursorSchema>>>();
    for (const pageSize of ["0", "-1", "1.5", "11", "", "no", ["2"], true, null]) {
      expect(schema.safeParse({ pageSize }).success).toBe(false);
    }
  });

  it("validates nested defaults and configuration limits", () => {
    const schema = createCursorPaginationInputSchema(cursorCodec);
    expect(schema.parse(undefined)).toEqual({ type: "cursor", pageSize: 20 });
    expect(schema.safeParse({ type: "cursor", after: null }).success).toBe(false);
    for (const options of [{ defaultPageSize: 101 }, { maxPageSize: 0 }, { defaultPageSize: 1.5 }]) {
      expect(() => createCursorPaginationInputSchema(cursorCodec, options)).toThrow(TypeError);
      expect(() => createCursorPaginationControllerInputSchema(cursorCodec, options)).toThrow(TypeError);
    }
  });

  it("derives flat input, preserves filters and revalidates the source action", async () => {
    const sourceSchema = z.object({
      category: z.string().min(1),
      pagination: createCursorPaginationInputSchema(cursorCodec, { defaultPageSize: 2, maxPageSize: 2 }),
    });
    const action = defineAction({ name: "record.list", input: sourceSchema, output: sourceSchema, handler: (value) => value });
    const derived = action.derive(mapCursorPaginationInput(cursorCodec));
    const app = new App({});
    try {
      const after = { id: 2, label: "two" };
      const result = app.get(derived).run({ category: "selected", pageSize: "2", after: z.encode(cursorCodec, after) });
      expectTypeOf(result).toEqualTypeOf<Promise<z.output<typeof sourceSchema>>>();
      await expect(result).resolves.toEqual({ category: "selected", pagination: { type: "cursor", pageSize: 2, after } });
      await expect(app.get(derived).run({ category: "selected", pageSize: "3" })).rejects.toThrow();
      expect(Object.keys(derived.inputSchema.shape)).toEqual(["category", "after", "pageSize"]);
      expect(Object.keys(action.inputSchema.shape)).toEqual(["category", "pagination"]);
    } finally {
      await app.dispose();
    }
  });

  it("supports bidirectional date fields without double-decoding source input", async () => {
    const dateSchema = z.codec(z.iso.datetime(), z.date(), {
      decode: (value) => new Date(value), encode: (value) => value.toISOString(),
    });
    const codec = createPaginationCursorCodec(z.object({ at: dateSchema, id: z.number().int() }));
    const action = defineAction({
      name: "record.dated",
      input: z.object({ pagination: createCursorPaginationInputSchema(codec) }),
      output: z.boolean(),
      handler: ({ pagination }) => pagination.after?.at instanceof Date,
    }).derive(mapCursorPaginationInput(codec));
    const app = new App({});
    try {
      const cursor = { at: new Date("2026-09-18T12:00:00.000Z"), id: 1 };
      await expect(app.get(action).run({ after: z.encode(codec, cursor) })).resolves.toBe(true);
      const result = createCursorPaginatedOutputSchema(z.string(), codec).parse({
        items: ["one"], pageInfo: { type: "cursor", pageSize: 1, hasNextPage: true, nextCursor: cursor },
      });
      expect(z.decode(codec, result.pageInfo.nextCursor!)).toEqual(cursor);
    } finally {
      await app.dispose();
    }
  });

  it("serializes continuation cursors and preserves the null end marker", () => {
    const schema = createCursorPaginatedOutputSchema(z.string(), cursorCodec);
    const cursor = { id: 2, label: "two" };
    const page = schema.parse({ items: ["one", "two"], pageInfo: {
      type: "cursor", pageSize: 2, hasNextPage: true, nextCursor: cursor,
    } });
    expect(page.pageInfo.nextCursor).toBe(z.encode(cursorCodec, cursor));
    expect(schema.parse({ items: [], pageInfo: {
      type: "cursor", pageSize: 2, hasNextPage: false, nextCursor: null,
    } }).pageInfo.nextCursor).toBeNull();
  });
});

// Cursor sizes additionally reserve a safely representable item for lookahead.
describe("cursor pagination boundary contracts", () => {
  for (const field of ["defaultPageSize", "maxPageSize"] as const) {
    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(`rejects invalid ${field} %s`, (value) => {
      const options = { defaultPageSize: 1, [field]: value };
      expect(() => createCursorPaginationInputSchema(cursorCodec, options)).toThrow(TypeError);
      expect(() => createCursorPaginationControllerInputSchema(cursorCodec, options)).toThrow(TypeError);
    });
  }

  it("accepts equal minimum bounds and preserves a safely representable lookahead", () => {
    const smallest = createCursorPaginationInputSchema(cursorCodec, { defaultPageSize: 1, maxPageSize: 1 });
    expect(smallest.parse(undefined)).toStrictEqual({ type: "cursor", pageSize: 1 });
    expect(smallest.parse({ type: "cursor", after: undefined })).toStrictEqual({ type: "cursor", pageSize: 1 });
    const size = Number.MAX_SAFE_INTEGER - 1;
    const largest = createCursorPaginationInputSchema(cursorCodec, { defaultPageSize: size, maxPageSize: size });
    expect(largest.parse(undefined)).toStrictEqual({ type: "cursor", pageSize: size });
    expect(createCursorPaginationControllerInputSchema(cursorCodec, { defaultPageSize: size, maxPageSize: size }).parse({ pageSize: String(size) })).toEqual({ pageSize: size });
  });

  it("rejects a null structured cursor even when the underlying value schema accepts null", () => {
    const nullable = createPaginationCursorCodec(z.object({ id: z.number() }).nullable());
    expect(createCursorPaginationInputSchema(nullable).safeParse({ type: "cursor", after: null }).success).toBe(false);
  });

  it("rejects invalid cursor tokens and oversized explicit nested input", () => {
    const input = createCursorPaginationInputSchema(cursorCodec, { defaultPageSize: 1, maxPageSize: 2 });
    for (const pageSize of [0, -1, 1.5, 3]) expect(input.safeParse({ type: "cursor", pageSize }).success).toBe(false);
    const controller = createCursorPaginationControllerInputSchema(cursorCodec);
    for (const after of ["!", "", "e30", z.encode(createPaginationCursorCodec(z.number()), 5)]) {
      expect(controller.safeParse({ after }).success).toBe(false);
    }
  });

  it("reports invalid outgoing cursor values as a custom cursor issue", () => {
    const schema = createCursorPaginatedOutputSchema(z.string(), cursorCodec);
    const result = schema.safeParse({ items: ["one"], pageInfo: {
      type: "cursor", pageSize: 1, hasNextPage: true, nextCursor: { id: "not-a-number", label: "one" },
    } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toMatchObject([
      { code: "custom", path: ["pageInfo", "nextCursor"] },
    ]);
  });
});
