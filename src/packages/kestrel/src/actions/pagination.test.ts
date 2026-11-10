import {
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import { z } from "zod";

import { App } from "../app/index.js";
import {
  createPaginatedOutputSchema,
  createPaginationInputSchema,
  defineAction,
  mapPaginationControllerInput,
  mapPaginationInput,
  paginationControllerInputSchema,
} from "./index.js";

describe("pagination action contracts", () => {
  it("defaults public pagination to a bounded first page", () => {
    const schema = createPaginationInputSchema({
      defaultPageSize: 25,
      maxPageSize: 50,
    });
    type BoundedPagination = z.output<typeof schema>;

    // @ts-expect-error The all strategy requires an opt-in schema.
    const invalidPagination: BoundedPagination = { type: "all" };

    expect(schema.parse(undefined)).toEqual({
      type: "page",
      page: 1,
      pageSize: 25,
    });
    expect(() =>
      schema.parse({ type: "all" }),
    ).toThrow(z.ZodError);
    void invalidPagination;
  });

  it("allows all results only when explicitly enabled", () => {
    const schema = createPaginationInputSchema({
      allowAll: true,
    });

    expect(schema.parse({ type: "all" })).toEqual({
      type: "all",
    });
  });

  it("validates numbered page limits", () => {
    const schema = createPaginationInputSchema({
      defaultPageSize: 10,
      maxPageSize: 10,
    });

    expect(() =>
      schema.parse({
        type: "page",
        page: 0,
        pageSize: 10,
      }),
    ).toThrow(z.ZodError);
  });

  it("maps flat controller values to action pagination", () => {
    const defaultInput =
      paginationControllerInputSchema.parse({});
    const customInput =
      paginationControllerInputSchema.parse({
        page: "3",
        pageSize: "25",
      });

    expect(mapPaginationControllerInput(defaultInput)).toEqual({
      pagination: {
        type: "page",
        page: 1,
        pageSize: 20,
      },
    });
    expect(mapPaginationControllerInput(customInput)).toEqual({
      pagination: {
        type: "page",
        page: 3,
        pageSize: 25,
      },
    });
  });

  it("derives a flat pagination input while preserving other fields", async () => {
    const sourceInputSchema = z.object({
      domain: z.hostname(),
      pagination: createPaginationInputSchema(),
    });
    const action = defineAction({
      name: "domain.list",
      input: sourceInputSchema,
      output: sourceInputSchema,
      handler: (input) => input,
    });
    const derivedAction =
      action.derive(mapPaginationInput);
    const app = new App({});

    const result = app.get(derivedAction).run({
      domain: "example.com",
      page: "3",
      pageSize: "25",
    });

    await expect(result).resolves.toEqual({
      domain: "example.com",
      pagination: {
        type: "page",
        page: 3,
        pageSize: 25,
      },
    });
    expect(Object.keys(derivedAction.inputSchema.shape))
      .toEqual(["domain", "page", "pageSize"]);
    expect(Object.keys(action.inputSchema.shape))
      .toEqual(["domain", "pagination"]);
    expectTypeOf(result).toEqualTypeOf<
      Promise<z.output<typeof sourceInputSchema>>
    >();

    await app.dispose();
  });

  it("validates every serialized result strategy", () => {
    const schema = createPaginatedOutputSchema(z.string());

    expect(
      schema.parse({
        items: ["one"],
        pageInfo: { type: "all" },
      }),
    ).toEqual({
      items: ["one"],
      pageInfo: { type: "all" },
    });
    expect(() =>
      schema.parse({
        items: ["one"],
        pageInfo: {
          type: "unknown",
          hasNextPage: true,
        },
      }),
    ).toThrow(z.ZodError);
  });
});

// Configuration defaults must satisfy the same numeric contract as explicit page input.
describe("numbered pagination configuration regressions", () => {
  it.each(["defaultPageSize", "maxPageSize"] as const)("rejects unsafe %s configuration", (field) => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(() => createPaginationInputSchema({ defaultPageSize: 1, maxPageSize: unsafe, [field]: unsafe })).toThrow(TypeError);
  });
});

// Opting into unbounded reads must leave omitted input bounded and explicitly validated.
describe("numbered pagination boundary contracts", () => {
  it("keeps a bounded first-page default when all-results reads are enabled", () => {
    const schema = createPaginationInputSchema({ allowAll: true, defaultPageSize: 7, maxPageSize: 10 });
    expect(schema.parse(undefined)).toEqual({ type: "page", page: 1, pageSize: 7 });
    expect(schema.parse({ type: "page" })).toEqual({ type: "page", page: 1, pageSize: 7 });
    expect(schema.parse({ type: "all" })).toEqual({ type: "all" });
  });

  for (const field of ["defaultPageSize", "maxPageSize"] as const) {
    it.each([0, -1, 1.5, NaN, Infinity])(`rejects invalid ${field} %s`, (value) => {
      expect(() => createPaginationInputSchema({ [field]: value })).toThrow(TypeError);
    });
  }

  it("accepts equal one-item bounds and the largest safe numbered size", () => {
    const smallest = createPaginationInputSchema({ defaultPageSize: 1, maxPageSize: 1 });
    expect(smallest.parse(undefined)).toEqual({ type: "page", page: 1, pageSize: 1 });
    const largest = createPaginationInputSchema({ defaultPageSize: Number.MAX_SAFE_INTEGER, maxPageSize: Number.MAX_SAFE_INTEGER });
    expect(largest.parse(undefined)).toEqual({ type: "page", page: 1, pageSize: Number.MAX_SAFE_INTEGER });
    expect(largest.parse({ type: "page", pageSize: Number.MAX_SAFE_INTEGER }).pageSize).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a configured default larger than its maximum", () => {
    expect(() => createPaginationInputSchema({ defaultPageSize: 11, maxPageSize: 10 })).toThrow(TypeError);
  });

  it("accepts the inclusive maximum and rejects invalid explicit page values", () => {
    const schema = createPaginationInputSchema({ defaultPageSize: 3, maxPageSize: 10 });
    expect(schema.parse({ type: "page", page: 1, pageSize: 10 })).toEqual({ type: "page", page: 1, pageSize: 10 });
    for (const value of [0, -1, 1.5, NaN, Infinity, "2"]) {
      expect(schema.safeParse({ type: "page", page: value, pageSize: 3 }).success).toBe(false);
      expect(schema.safeParse({ type: "page", page: 1, pageSize: value }).success).toBe(false);
    }
    expect(schema.safeParse({ type: "page", pageSize: 11 }).success).toBe(false);
  });

  it("rejects invalid controller page fields while accepting the one-item boundary", () => {
    expect(paginationControllerInputSchema.parse({ page: "1", pageSize: "1" })).toEqual({ page: 1, pageSize: 1 });
    for (const value of ["0", "-1", "1.5", "no", ""]) {
      expect(paginationControllerInputSchema.safeParse({ page: value }).success).toBe(false);
      expect(paginationControllerInputSchema.safeParse({ pageSize: value }).success).toBe(false);
    }
    expect(paginationControllerInputSchema.safeParse({ pageSize: "101" }).success).toBe(false);
  });

  it("validates numbered output metadata and every item", () => {
    const schema = createPaginatedOutputSchema(z.string());
    const result = { items: ["first"], pageInfo: { type: "page", page: 1, pageSize: 1, hasNextPage: false } };
    expect(schema.parse(result)).toEqual(result);
    expect(schema.safeParse({ ...result, items: [1] }).success).toBe(false);
    for (const pageInfo of [
      { ...result.pageInfo, page: 0 }, { ...result.pageInfo, pageSize: 0 },
      { ...result.pageInfo, page: 1.5 }, { ...result.pageInfo, pageSize: 1.5 },
      { ...result.pageInfo, hasNextPage: "false" },
    ]) expect(schema.safeParse({ ...result, pageInfo }).success).toBe(false);
  });

  it("removes transport-only fields while preserving passthrough action filters", async () => {
    const source = z.object({ category: z.string(), pagination: createPaginationInputSchema() }).passthrough();
    const action = defineAction({ name: "record.filtered", input: source, output: source, handler: (value) => value }).derive(mapPaginationInput);
    const app = new App({});
    try {
      expect(await app.get(action).run({ category: "selected", page: "2", pageSize: "3", customFilter: "retained" })).toStrictEqual({
        category: "selected", customFilter: "retained", pagination: { type: "page", page: 2, pageSize: 3 },
      });
    } finally { await app.dispose(); }
  });
});
