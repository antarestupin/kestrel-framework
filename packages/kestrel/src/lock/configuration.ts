import { z } from "zod";

import {
  defineConfigBase,
  type ConfigOutput,
} from "../configuration/index.js";

const numericInput = z.union([z.number(), z.string()]);
const positiveNumber = numericInput.pipe(
  z.coerce.number<string | number>().positive().finite(),
);
const nonNegativeNumber = numericInput.pipe(
  z.coerce.number<string | number>().nonnegative().finite(),
);
const positiveInteger = numericInput.pipe(
  z.coerce.number<string | number>().int().positive(),
);
const nonNegativeInteger = numericInput.pipe(
  z.coerce.number<string | number>().int().nonnegative(),
);
const jitterRatio = numericInput.pipe(
  z.coerce.number<string | number>().min(0).max(1),
);

/** Configuration contract required by the distributed lock library. */
export const lockConfigBase = defineConfigBase(z.object({
  // The application owns its namespace because it identifies deployed data.
  namespace: z.string().min(1),
  defaultTtlMs: positiveNumber.default(30_000),
  maxTtlMs: positiveNumber.default(300_000),
  defaultWaitTimeoutMs: nonNegativeNumber.default(5_000),
  retryIntervalMs: positiveNumber.default(50),
  retryJitterRatio: jitterRatio.default(0.2),
  pruneBatchSize: positiveInteger.default(1_000),
  pruneIntervalSeconds: nonNegativeInteger.default(60),
}));

export type LockConfig = ConfigOutput<typeof lockConfigBase>;
