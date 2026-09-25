import type { StudioClientExtensionDefinition } from "../../../client/src/extensions.js";
import {
  WORKERS_STUDIO_PAGE_KIND,
  WORKER_STUDIO_PAGE_KIND,
} from "../contract.js";

/** Lazily loads worker tooling when a worker page is visited. */
export const studioClientExtension = {
  pageKinds: [WORKERS_STUDIO_PAGE_KIND, WORKER_STUDIO_PAGE_KIND],
  load: () => import("./index.js"),
} satisfies StudioClientExtensionDefinition;
