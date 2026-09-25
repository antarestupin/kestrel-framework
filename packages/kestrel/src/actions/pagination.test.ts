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
