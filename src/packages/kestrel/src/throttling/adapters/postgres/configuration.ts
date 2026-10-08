import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../../../configuration/index.js";

/** Validated storage settings; connection ownership remains with infrastructure. */
export const postgresThrottlingConfigBase = defineConfigBase(z.object({
  maxConcurrentReservations: z.union([z.number(), z.string()]).pipe(z.coerce.number<string | number>().int().positive()).default(8),
  maxPendingReservations: z.union([z.number(), z.string()]).pipe(z.coerce.number<string | number>().int().nonnegative()).default(1_000),
  storageWaitTimeoutMs: z.union([z.number(), z.string()]).pipe(z.coerce.number<string | number>().int().positive()).default(1_000),
}));
export type PostgresThrottlingConfig = ConfigOutput<typeof postgresThrottlingConfigBase>;
