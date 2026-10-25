import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../../../configuration/index.js";

/** Buckets expire natively after refill and expiry of every outstanding grant. */
export const redisThrottlingConfigBase = defineConfigBase(z.object({
  keyPrefix: z.string().min(1).default("kestrel:throttling:"),
}));
export type RedisThrottlingConfig = ConfigOutput<typeof redisThrottlingConfigBase>;
