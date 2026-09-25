import { type ZodType } from "zod";

import {
  type Action,
  mapPaginationInput,
} from "../actions/index.js";
import type { PagePagination } from "../db/index.js";
import type { DependencyDeclarations } from "../di/index.js";
import type { HttpControllerAudience } from "./audiences/index.js";
import type { HttpAccessPolicy } from "./access.js";
import {
  defineActionHttpController,
  type HttpObjectSchema,
} from "./controller.js";
import { get } from "./route.js";

export interface ModelListActionHttpControllerOptions {
  /** Selects the targets that may expose this contract. */
  audiences?: readonly HttpControllerAudience[];
}

/**
 * Exposes a conventional model list action as an HTTP GET route.
 */
export function defineModelListActionHttpController<
  ActionInputSchema extends HttpObjectSchema
    & ZodType<{ pagination: PagePagination }>,
  ActionOutputSchema extends ZodType,
  const Dependencies extends DependencyDeclarations<never>,
>(
  action: Action<
    ActionInputSchema,
    ActionOutputSchema,
    Dependencies
  >,
  url: string,
  access: HttpAccessPolicy,
  options: ModelListActionHttpControllerOptions = {},
) {
  const controllerAction =
    action.derive(mapPaginationInput);

  return defineActionHttpController(
    controllerAction,
    get(url),
    access,
    options,
  );
}
