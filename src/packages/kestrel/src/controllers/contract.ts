import {
  type input,
  type ZodObject,
  type ZodRawShape,
  type ZodType,
  z,
} from "zod";

import type {
  DependencyDeclarations,
} from "../di/index.js";
import type { DefinitionContract } from "../definitions/index.js";

export type ControllerObjectSchema = ZodObject<ZodRawShape>;
export type ControllerOutputSchema = ZodType | undefined;

/** Shared empty input contract used by controllers without declared input. */
export const emptyControllerInputSchema = z.object({});

/** Infers a handler result only when an output contract is declared. */
export type ControllerHandlerResult<
  OutputSchema extends ControllerOutputSchema,
> = [OutputSchema] extends [undefined]
  ? unknown
  : OutputSchema extends ZodType
    ? input<OutputSchema>
    : unknown;

/**
 * Describes the transport-independent contract shared by HTTP and CLI
 * controllers, whether or not they delegate to an action.
 */
export interface ControllerContract<
  InputSchema extends ControllerObjectSchema,
  OutputSchema extends ControllerOutputSchema,
  Dependencies extends DependencyDeclarations<never>,
> extends DefinitionContract<InputSchema, OutputSchema, Dependencies> {}
