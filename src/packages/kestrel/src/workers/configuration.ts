import { z } from "zod";

import {
  defineConfigBase,
  type ConfigOutput,
} from "../configuration/index.js";

const positiveInteger = z.union([z.number(), z.string()]).pipe(
  z.coerce.number<string | number>().int().positive(),
);

/** Configuration contract required by the worker runtime. */
export const workersConfigBase = defineConfigBase(z.object({
  slots: positiveInteger.default(10),
  leaseMs: positiveInteger.default(300_000),
  reservationLimit: positiveInteger.default(100),
  pollIntervalMs: positiveInteger.default(1_000),
  readyQueueRefreshMs: positiveInteger.default(1_000),
  ackBufferSize: positiveInteger.default(100),
  ackFlushIntervalMs: positiveInteger.default(10),
  deferBufferSize: positiveInteger.default(100),
  deferFlushIntervalMs: positiveInteger.default(10),
  shutdownBehavior: z.enum(["wait", "release", "expire"]).default("wait"),
}));

export type WorkersConfig = ConfigOutput<typeof workersConfigBase>;
