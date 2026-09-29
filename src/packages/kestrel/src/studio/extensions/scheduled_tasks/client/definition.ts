import type { StudioClientExtensionDefinition } from "../../../client/src/extensions.js";
import { SCHEDULED_TASKS_STUDIO_PAGE_KIND } from "../contract.js";

/** Lazily loads scheduled-task tooling when its page is visited. */
export const studioClientExtension = {
  pageKinds: [SCHEDULED_TASKS_STUDIO_PAGE_KIND],
  load: () => import("./index.js"),
} satisfies StudioClientExtensionDefinition;
