import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../../../configuration/index.js";

/** Connection settings belong to the application Redis provider. */
export const redisLocksConfigBase = defineConfigBase(z.object({
  keyPrefix: z.string().min(1).default("kestrel:lock:"),
}));
export type RedisLocksConfig = ConfigOutput<typeof redisLocksConfigBase>;
