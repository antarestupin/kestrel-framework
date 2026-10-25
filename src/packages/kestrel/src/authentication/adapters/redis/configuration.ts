import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../../../configuration/index.js";

/** Session records and account indexes expire at their absolute retention deadline. */
export const redisSessionsConfigBase = defineConfigBase(z.object({
  keyPrefix: z.string().min(1).default("kestrel:authentication:"),
}));
export type RedisSessionsConfig = ConfigOutput<typeof redisSessionsConfigBase>;
