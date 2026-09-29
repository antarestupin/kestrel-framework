import { z } from "zod";

import {
  defineConfigBase,
  type ConfigOutput,
} from "../configuration/index.js";

const numericInput = z.union([z.number(), z.string()]);
const positiveInteger = numericInput.pipe(
  z.coerce.number<string | number>().int().positive(),
);
const nonNegativeInteger = numericInput.pipe(
  z.coerce.number<string | number>().int().nonnegative(),
);

/** Configuration contract required by the scheduled-task runtime. */
export const scheduledTasksConfigBase = defineConfigBase(z.object({
  slots: positiveInteger.default(10),
  leaseMs: positiveInteger.default(300_000),
  pollIntervalMs: positiveInteger.default(1_000),
  defaultState: z.enum(["memory", "persistent"]).default("persistent"),
  defaultCoordination: z.enum(["distributed", "local"]).default("distributed"),
  expiredRunPruneBatchSize: positiveInteger.default(1_000),
  expiredRunPruneIntervalSeconds: nonNegativeInteger.default(60),
}));

export type ScheduledTasksConfig = ConfigOutput<
  typeof scheduledTasksConfigBase
>;
