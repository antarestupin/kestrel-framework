import { z } from "zod";

import {
  defineConfigBase,
  type ConfigOutput,
} from "../configuration/index.js";

const positiveInteger = z.union([z.number(), z.string()]).pipe(
  z.coerce.number<string | number>().int().positive(),
);
const nonNegativeNumber = z.union([z.number(), z.string()]).pipe(
  z.coerce.number<string | number>().nonnegative(),
);

/** Configuration contract required by the observation provider. */
export const observationConfigBase = defineConfigBase(z.object({
  enabled: z.boolean().default(false),
  retentionDays: positiveInteger.default(7),
  overflowPolicy: z.literal("drop-new").default("drop-new"),
  failurePolicy: z.enum(["best-effort", "fail-fast"]).default("best-effort"),
  buffer: z.object({
    batchSize: positiveInteger.default(50),
    flushIntervalMs: positiveInteger.default(100),
    maxQueueSize: positiveInteger.default(10_000),
  }).default({
    batchSize: 50,
    flushIntervalMs: 100,
    maxQueueSize: 10_000,
  }),
  retry: z.object({
    maxAttempts: positiveInteger.default(5),
    initialDelayMs: nonNegativeNumber.default(100),
    maxDelayMs: nonNegativeNumber.default(5_000),
  }).refine(
    ({ initialDelayMs, maxDelayMs }) => initialDelayMs <= maxDelayMs,
    { message: "Initial retry delay cannot exceed its maximum delay." },
  ).default({
    maxAttempts: 5,
    initialDelayMs: 100,
    maxDelayMs: 5_000,
  }),
}));

export type ObservationConfig = ConfigOutput<typeof observationConfigBase>;
