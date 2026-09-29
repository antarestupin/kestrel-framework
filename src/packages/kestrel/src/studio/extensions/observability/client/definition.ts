import type { StudioClientExtensionDefinition } from "../../../client/src/extensions.js";
import {
  DEV_OBSERVATIONS_PAGE_KIND,
  DEV_OBSERVATION_CORRELATION_PAGE_KIND,
  DEV_OBSERVATION_EXECUTION_PAGE_KIND,
  DEV_OBSERVATION_LIST_PAGE_KIND,
} from "../contract.js";

/** Lazily loads observability renderers when one of their pages is visited. */
export const studioClientExtension = {
  pageKinds: [
    DEV_OBSERVATIONS_PAGE_KIND,
    DEV_OBSERVATION_CORRELATION_PAGE_KIND,
    DEV_OBSERVATION_EXECUTION_PAGE_KIND,
    DEV_OBSERVATION_LIST_PAGE_KIND,
  ],
  load: () => import("./index.js"),
} satisfies StudioClientExtensionDefinition;
