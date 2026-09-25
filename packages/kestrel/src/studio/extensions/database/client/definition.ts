import type { StudioClientExtensionDefinition } from "../../../client/src/extensions.js";
import { DATABASE_SCHEMA_PAGE_KIND } from "../contract.js";

/** Lazily loads the database schema client when its page is visited. */
export const studioClientExtension = {
  pageKinds: [DATABASE_SCHEMA_PAGE_KIND],
  load: () => import("./index.js"),
} satisfies StudioClientExtensionDefinition;
