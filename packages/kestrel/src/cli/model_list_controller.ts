import { type ZodType } from "zod";

import {
  type Action,
  mapPaginationInput,
} from "../actions/index.js";
import type { PagePagination } from "../db/index.js";
import type { DependencyDeclarations } from "../di/index.js";
import {
  defineActionCliController,
  type CliObjectSchema,
} from "./controller.js";

/**
 * Exposes a conventional model list action as a CLI command.
 */
export function defineModelListActionCliController<
  ActionInputSchema extends CliObjectSchema
    & ZodType<{ pagination: PagePagination }>,
  ActionOutputSchema extends ZodType,
  const Dependencies extends DependencyDeclarations<never>,
>(
  action: Action<
    ActionInputSchema,
    ActionOutputSchema,
    Dependencies
  >,
  command: string,
) {
  return defineActionCliController(
    action.derive(mapPaginationInput),
    command,
  );
}
