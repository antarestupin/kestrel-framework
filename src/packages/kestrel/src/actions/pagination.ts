import {
  z,
  type input,
  type output,
  type ZodObject,
  type ZodRawShape,
  type ZodType,
} from "zod";

import type {
  AllPagination,
  PagePagination,
} from "../db/index.js";
import type { DependencyDeclarations } from "../di/index.js";
import type { Action } from "./action.js";
import { mapActionInput } from "./input_mapping.js";

export const DEFAULT_PAGINATION_PAGE_SIZE = 20;
export const MAX_PAGINATION_PAGE_SIZE = 100;

export interface PaginationInputSchemaOptions {
  allowAll?: boolean;
  defaultPageSize?: number;
  maxPageSize?: number;
}

type PagePaginationSchemaInput = {
  type: "page";
  page?: number | undefined;
  pageSize?: number | undefined;
};

type BoundedPaginationSchemaInput =
  | PagePaginationSchemaInput
  | undefined;

type AllPaginationSchemaInput =
  | AllPagination
  | BoundedPaginationSchemaInput;

/**
 * Creates the public pagination input shared by list actions.
 */
export function createPaginationInputSchema(
  options: PaginationInputSchemaOptions & {
    allowAll: true;
  },
): ZodType<
  AllPagination | PagePagination,
  AllPaginationSchemaInput
>;
export function createPaginationInputSchema(
  options?: PaginationInputSchemaOptions & {
    allowAll?: false;
  },
): ZodType<
  PagePagination,
  BoundedPaginationSchemaInput
>;
export function createPaginationInputSchema({
  allowAll = false,
  defaultPageSize = DEFAULT_PAGINATION_PAGE_SIZE,
  maxPageSize = MAX_PAGINATION_PAGE_SIZE,
}: PaginationInputSchemaOptions = {}): ZodType<
  AllPagination | PagePagination,
  AllPaginationSchemaInput
> {
  assertPageSizeOption("defaultPageSize", defaultPageSize);
  assertPageSizeOption("maxPageSize", maxPageSize);

  if (defaultPageSize > maxPageSize) {
    throw new TypeError(
      "The default pagination page size cannot exceed the maximum page size.",
    );
  }

  const pageSchema = z.object({
    type: z.literal("page"),
    page: z.number().int().min(1).default(1),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(maxPageSize)
      .default(defaultPageSize),
  });
  if (allowAll) {
    return z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("all") }),
        pageSchema,
      ])
      .default({
        type: "page",
        page: 1,
        pageSize: defaultPageSize,
      });
  }

  return pageSchema.default({
    type: "page",
    page: 1,
    pageSize: defaultPageSize,
  });
}

/**
 * Parses the flat page options shared by interface controllers.
 */
export const paginationControllerInputSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGINATION_PAGE_SIZE)
    .default(DEFAULT_PAGINATION_PAGE_SIZE),
});

/**
 * Maps flat controller options to the nested action pagination contract.
 */
export function mapPaginationControllerInput(
  input: z.output<
    typeof paginationControllerInputSchema
  >,
): { pagination: PagePagination } {
  return {
    pagination: {
      type: "page",
      page: input.page,
      pageSize: input.pageSize,
    },
  };
}

/**
 * Derives the flat page and page-size contract used by controllers while
 * preserving every non-pagination field from the source action input.
 */
type PaginatedObjectSchema =
  ZodObject<ZodRawShape>
  & ZodType<{ pagination: PagePagination }>;

type MappedPaginationInputSchema<
  InputSchema extends PaginatedObjectSchema,
> =
  ZodObject<
    Omit<InputSchema["shape"], "pagination">
      & typeof paginationControllerInputSchema.shape
  >
  & ZodType<
    Omit<output<InputSchema>, "pagination">
      & output<typeof paginationControllerInputSchema>,
    Omit<input<InputSchema>, "pagination">
      & input<typeof paginationControllerInputSchema>
  >;

export function mapPaginationInput<
  InputSchema extends PaginatedObjectSchema,
  OutputSchema extends ZodType,
  const Dependencies extends DependencyDeclarations<never>,
>(
  action: Action<
    InputSchema,
    OutputSchema,
    Dependencies
  >,
): Action<
  MappedPaginationInputSchema<InputSchema>,
  OutputSchema,
  Dependencies
> {
  // The public constraint guarantees an object schema containing pagination;
  // the broad local view avoids leaking Zod's shape-level omit internals.
  const objectSchema =
    action.inputSchema as ZodObject<ZodRawShape>;
  const inputSchema = objectSchema
    .omit({ pagination: true })
    .extend(
      paginationControllerInputSchema.shape,
    ) as unknown as MappedPaginationInputSchema<InputSchema>;

  return mapActionInput(
    inputSchema,
    (input) => {
      const {
        page: _page,
        pageSize: _pageSize,
        ...actionInput
      } = input;
      const paginationInput =
        paginationControllerInputSchema.parse(input);

      return {
        ...actionInput,
        ...mapPaginationControllerInput(
          paginationInput,
        ),
      } as input<InputSchema>;
    },
  )(action) as Action<
    MappedPaginationInputSchema<InputSchema>,
    OutputSchema,
    Dependencies
  >;
}

/**
 * Creates the serialized collection result shared by list actions.
 */
export function createPaginatedOutputSchema<
  ItemSchema extends ZodType,
>(
  itemSchema: ItemSchema,
) {
  return z.object({
    items: z.array(itemSchema),
    pageInfo: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("all"),
      }),
      z.object({
        type: z.literal("page"),
        page: z.number().int().min(1),
        pageSize: z.number().int().min(1),
        hasNextPage: z.boolean(),
      }),
    ]),
  });
}

function assertPageSizeOption(
  name: string,
  value: number,
): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(
      `The pagination ${name} must be a positive integer.`,
    );
  }
}
