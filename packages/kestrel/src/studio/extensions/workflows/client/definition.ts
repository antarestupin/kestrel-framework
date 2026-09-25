import type { StudioClientExtensionDefinition } from "../../../client/src/extensions.js";
import {
  WORKFLOWS_STUDIO_CATALOG_PAGE_KIND,
  WORKFLOWS_STUDIO_EXECUTION_PAGE_KIND,
} from "../contract.js";

/** Lazily loads workflow tooling when a workflow page is visited. */
export const studioClientExtension = {
  pageKinds: [
    WORKFLOWS_STUDIO_CATALOG_PAGE_KIND,
    WORKFLOWS_STUDIO_EXECUTION_PAGE_KIND,
  ],
  load: () => import("./index.js"),
} satisfies StudioClientExtensionDefinition;
