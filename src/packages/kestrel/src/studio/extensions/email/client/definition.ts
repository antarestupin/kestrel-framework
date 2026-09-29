import type { StudioClientExtensionDefinition } from "../../../client/src/extensions.js";
import {
  DEV_EMAIL_CAPTURE_PAGE_KIND,
  DEV_EMAIL_HISTORY_PAGE_KIND,
  DEV_EMAIL_INBOX_PAGE_KIND,
} from "../contract.js";

/** Lazily loads the local email inbox when one of its pages is visited. */
export const studioClientExtension = {
  pageKinds: [
    DEV_EMAIL_HISTORY_PAGE_KIND,
    DEV_EMAIL_INBOX_PAGE_KIND,
    DEV_EMAIL_CAPTURE_PAGE_KIND,
  ],
  load: () => import("./index.js"),
} satisfies StudioClientExtensionDefinition;
