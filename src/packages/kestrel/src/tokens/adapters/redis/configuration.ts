import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../../../configuration/index.js";

/** Token retention is controlled by prune(), independently of logical expiry. */
export const redisTokensConfigBase = defineConfigBase(z.object({
  keyPrefix: z.string().min(1).default("kestrel:tokens:"),
}));
export type RedisTokensConfig = ConfigOutput<typeof redisTokensConfigBase>;
