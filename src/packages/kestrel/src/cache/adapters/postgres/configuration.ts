import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../../../configuration/index.js";

/** Validated storage settings; connection ownership remains with infrastructure. */
export const postgresCacheConfigBase = defineConfigBase(z.object({
  maxEntries: z.union([z.number(), z.string()]).pipe(z.coerce.number<string | number>().int().positive()).default(100_000),
}));
export type PostgresCacheConfig = ConfigOutput<typeof postgresCacheConfigBase>;
