import type { StudioClientExtensionDefinition } from "../../../client/src/extensions.js";
import { CONTROLLERS_STUDIO_PAGE_KIND } from "../contract.js";

/** Lazily loads the controller explorer client when its page is visited. */
export const studioClientExtension = {
  pageKinds: [CONTROLLERS_STUDIO_PAGE_KIND],
  load: () => import("./index.js"),
} satisfies StudioClientExtensionDefinition;
