import { z } from "zod";

import {
  defineConfigBase,
  type ConfigOutput,
} from "../configuration/index.js";

/** Configuration contract required by the Studio provider. */
export const studioConfigBase = defineConfigBase(z.object({
  enabled: z.boolean().default(false),
  devMode: z.boolean().default(false),
  basePath: z.string().min(1).default("/_studio"),
}));

export type StudioConfig = ConfigOutput<typeof studioConfigBase>;
