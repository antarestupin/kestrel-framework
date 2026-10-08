import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../../../configuration/index.js";

/** Validated storage settings; connection ownership remains with infrastructure. */
export const redisCacheConfigBase = defineConfigBase(z.object({
  keyPrefix: z.string().min(1).default("kestrel:cache:"),
}));
export type RedisCacheConfig = ConfigOutput<typeof redisCacheConfigBase>;
