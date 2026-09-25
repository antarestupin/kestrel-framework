import type { StudioClientExtensionDefinition } from "../../../client/src/extensions.js";
import { DEV_LOGS_PAGE_KIND } from "../contract.js";

/** Lazily loads the development logs client when its page is visited. */
export const studioClientExtension = {
  pageKinds: [DEV_LOGS_PAGE_KIND],
  load: () => import("./index.js"),
} satisfies StudioClientExtensionDefinition;
