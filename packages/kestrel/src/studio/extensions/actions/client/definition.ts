import type { StudioClientExtensionDefinition } from "../../../client/src/extensions.js";
import { ACTIONS_DOCUMENTATION_PAGE_KIND } from "../contract.js";

/** Lazily loads the actions documentation client when its page is visited. */
export const studioClientExtension = {
  pageKinds: [ACTIONS_DOCUMENTATION_PAGE_KIND],
  load: () => import("./index.js"),
} satisfies StudioClientExtensionDefinition;
