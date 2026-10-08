import { z } from "zod";

import { defineConfigBase, type ConfigOutput } from "../configuration/index.js";
import { defaultMaxErrorBodyBytes, defaultMaxResponseBytes } from "./defaults.js";

const numericInput = z.union([z.number(), z.string()]);
const positiveNumber = numericInput.pipe(z.coerce.number<string | number>().positive());
const positiveInteger = numericInput.pipe(z.coerce.number<string | number>().int().positive());

/** Portable outbound budgets; applications choose whether to impose a deadline. */
export const outboundHttpConfigBase = defineConfigBase(z.object({
  timeoutMs: positiveNumber.optional(),
  maxResponseBytes: positiveInteger.default(defaultMaxResponseBytes),
  maxErrorBodyBytes: positiveInteger.default(defaultMaxErrorBodyBytes),
}));

export type OutboundHttpConfig = ConfigOutput<typeof outboundHttpConfigBase>;
