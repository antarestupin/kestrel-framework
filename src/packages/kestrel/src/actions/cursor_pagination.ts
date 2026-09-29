import { z, type input, type output, type ZodObject, type ZodRawShape, type ZodType } from "zod";

import type { CursorPagination } from "../db/index.js";
import type { DependencyDeclarations } from "../di/index.js";
import type { Action } from "./action.js";
import { mapActionInput } from "./input_mapping.js";
import {
  DEFAULT_PAGINATION_PAGE_SIZE,
  MAX_PAGINATION_PAGE_SIZE,
  type PaginationInputSchemaOptions,
} from "./pagination.js";

import type { PaginationCursorCodec } from "../utils/cursor_codec.js";

// Preserve the actions API while sharing the codec with lower-level libraries.
export { createPaginationCursorCodec, type PaginationCursorCodec } from "../utils/cursor_codec.js";
export type CursorPaginationInputSchemaOptions = Omit<PaginationInputSchemaOptions, "allowAll">;

/** Validates structured action input while supplying bounded first-page defaults. */
export function createCursorPaginationInputSchema<Schema extends ZodType>(
  codec: PaginationCursorCodec<Schema>,
  options: CursorPaginationInputSchemaOptions = {},
) {
  const { defaultPageSize, maxPageSize } = resolvePageSizes(options);
  return z.object({
    type: z.literal("cursor"),
    after: codec.out.refine((value) => value != null, "Cursor values must be non-null.").optional(),
    pageSize: z.number().int().min(1).max(maxPageSize).default(defaultPageSize),
  }).prefault({ type: "cursor" }).transform(({ after, ...pagination }): CursorPagination<output<Schema>> => ({
    ...pagination,
    ...(after === undefined ? {} : { after }),
  }));
}

/** Validates flat URL/CLI fields while retaining an idempotent wire contract. */
export function createCursorPaginationControllerInputSchema<Schema extends ZodType>(
  codec: PaginationCursorCodec<Schema>,
  options: CursorPaginationInputSchemaOptions = {},
) {
  const { defaultPageSize, maxPageSize } = resolvePageSizes(options);
  return z.object({
    // Controllers and action runners both validate this schema. Keep the token
    // intact until mapping, so a decoded object is never parsed as a token.
    after: codec.in.refine((token) => codec.safeParse(token).success, "Invalid pagination cursor.").optional(),
    pageSize: z.union([z.string(), z.number()])
      .pipe(z.coerce.number<string | number>().int().min(1).max(maxPageSize)).default(defaultPageSize),
  });
}

/** Converts validated flat values to the repository-facing request contract. */
export function mapCursorPaginationControllerInput<Schema extends ZodType>(
  codec: PaginationCursorCodec<Schema>,
  value: { after?: string | undefined; pageSize: number },
): { pagination: CursorPagination<output<Schema>> } {
  return { pagination: {
    type: "cursor",
    pageSize: value.pageSize,
    ...(value.after === undefined ? {} : { after: z.decode(codec, value.after) }),
  } };
}

type CursorControllerSchema<Schema extends ZodType> = ReturnType<typeof createCursorPaginationControllerInputSchema<Schema>>;
type CursorActionSchema<Schema extends ZodType> = ZodObject<ZodRawShape>
  & ZodType<{ pagination: CursorPagination<output<Schema>> }>;
type MappedCursorInputSchema<Source extends ZodObject<ZodRawShape>, Schema extends ZodType> =
  ZodObject<Omit<Source["shape"], "pagination"> & CursorControllerSchema<Schema>["shape"]>
  & ZodType<
    Omit<output<Source>, "pagination"> & output<CursorControllerSchema<Schema>>,
    Omit<input<Source>, "pagination"> & input<CursorControllerSchema<Schema>>
  >;

/** Derives a flat cursor contract while retaining filters and action validation. */
export function mapCursorPaginationInput<Schema extends ZodType>(
  codec: PaginationCursorCodec<Schema>,
  options: CursorPaginationInputSchemaOptions = {},
) {
  const controllerSchema = createCursorPaginationControllerInputSchema(codec, options);
  return <
    Source extends CursorActionSchema<Schema>,
    Result extends ZodType,
    const Dependencies extends DependencyDeclarations<never>,
  >(action: Action<Source, Result, Dependencies>): Action<MappedCursorInputSchema<Source, Schema>, Result, Dependencies> => {
    const objectSchema = action.inputSchema as ZodObject<ZodRawShape>;
    const mappedSchema = objectSchema.omit({ pagination: true }).extend(controllerSchema.shape) as unknown as MappedCursorInputSchema<Source, Schema>;
    return mapActionInput(mappedSchema, (value) => {
      const { after, pageSize, ...other } = value;
      const { pagination } = mapCursorPaginationControllerInput(codec, { after, pageSize });
      // The source schema parses once more: restore its input representation
      // so bidirectional cursor fields (for example date codecs) are not double-decoded.
      return {
        ...other,
        pagination: {
          ...pagination,
          ...(pagination.after === undefined ? {} : { after: z.encode(codec.out, pagination.after) }),
        },
      } as input<Source>;
    })(action) as Action<MappedCursorInputSchema<Source, Schema>, Result, Dependencies>;
  };
}

/** Serializes repository cursor metadata with a token reusable in the next URL. */
export function createCursorPaginatedOutputSchema<Item extends ZodType, Schema extends ZodType>(
  itemSchema: Item,
  codec: PaginationCursorCodec<Schema>,
) {
  return z.object({
    items: z.array(itemSchema),
    pageInfo: z.object({
      type: z.literal("cursor"),
      pageSize: z.number().int().min(1),
      hasNextPage: z.boolean(),
      // Encode backward through the whole schema, including nested codecs.
      nextCursor: z.custom<output<Schema>>().transform((value, context) => {
        const encoded = z.safeEncode<PaginationCursorCodec<Schema>>(codec, value);
        if (!encoded.success) {
          context.issues.push({ code: "custom", message: "Invalid pagination cursor.", input: value });
          return z.NEVER;
        }
        return encoded.data;
      }).pipe(codec.in).nullable(),
    }),
  });
}

function resolvePageSizes(options: CursorPaginationInputSchemaOptions) {
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGINATION_PAGE_SIZE;
  const maxPageSize = options.maxPageSize ?? MAX_PAGINATION_PAGE_SIZE;
  if (![defaultPageSize, maxPageSize].every((value) => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER)
    || defaultPageSize > maxPageSize) {
    throw new TypeError("Cursor page sizes must be positive safe integers with defaultPageSize <= maxPageSize and room for lookahead.");
  }
  return { defaultPageSize, maxPageSize };
}
