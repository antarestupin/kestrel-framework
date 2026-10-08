import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../../../configuration/index.js";

/** Validated storage settings; connection ownership remains with infrastructure. */
export const memoryCacheConfigBase = defineConfigBase(z.object({
  maxEntries: z.union([z.number(), z.string()]).pipe(z.coerce.number<string | number>().int().positive()).default(100_000),
  maxSizeBytes: z.union([z.number(), z.string()]).pipe(z.coerce.number<string | number>().int().positive()).default(67_108_864),
}));
export type MemoryCacheConfig = ConfigOutput<typeof memoryCacheConfigBase>;
