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

/** Configuration contract required by the shared cache library. */
export const cacheConfigBase = defineConfigBase(z.object({
  // The application owns its namespace because it identifies deployed data.
  namespace: z.string().min(1),
  lockKeyPrefix: z.string().min(1).default("cache-fill"),
  defaultTtlSeconds: positiveInteger.default(3_600),
  maxTtlSeconds: positiveInteger.default(86_400),
  maxEntrySizeBytes: positiveInteger.default(1_048_576),
  pruneBatchSize: positiveInteger.default(1_000),
  pruneIntervalSeconds: nonNegativeInteger.default(60),
}));

export type CacheConfig = ConfigOutput<typeof cacheConfigBase>;
