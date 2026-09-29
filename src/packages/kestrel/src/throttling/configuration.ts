import { z } from "zod";

import {
  defineConfigBase,
  type ConfigOutput,
} from "../configuration/index.js";

const numericInput = z.union([z.number(), z.string()]);
const positiveNumber = numericInput.pipe(
  z.coerce.number<string | number>().positive().finite(),
);
const positiveInteger = numericInput.pipe(
  z.coerce.number<string | number>().int().positive(),
);
const nonNegativeInteger = numericInput.pipe(
  z.coerce.number<string | number>().int().nonnegative(),
);

const pressureSampling = z.object({
  healthyIntervalMs: positiveNumber.default(1_000),
  nearThresholdIntervalMs: positiveNumber.default(500),
  pressuredIntervalMs: positiveNumber.default(250),
  nearThresholdRatio: numericInput.pipe(
    z.coerce.number<string | number>().min(0).lt(1),
  ).default(0.2),
}).default({
  healthyIntervalMs: 1_000,
  nearThresholdIntervalMs: 500,
  pressuredIntervalMs: 250,
  nearThresholdRatio: 0.2,
});

const backendFailurePolicy = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("reject") }),
  z.object({
    strategy: z.literal("emergency-local"),
    capacity: positiveNumber.pipe(z.number().min(1)),
    periodMs: positiveNumber,
  }),
]);

/** Configuration required by exact application-wide throttling. */
export const throttlingConfigBase = defineConfigBase(z.object({
  // The application owns this deployed-data namespace.
  namespace: z.string().min(1),
  maxPendingAcquisitions: nonNegativeInteger.default(1_000),
  maxConcurrentReservations: positiveInteger.default(8),
  storageWaitTimeoutMs: positiveNumber.default(1_000),
  backendFailurePolicy: backendFailurePolicy.default({ strategy: "reject" }),
  pruneBatchSize: positiveInteger.default(1_000),
  pruneIntervalSeconds: nonNegativeInteger.default(60),
  resourcePressureSampling: pressureSampling,
}));

export type ThrottlingConfig = ConfigOutput<typeof throttlingConfigBase>;
