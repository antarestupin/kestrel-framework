import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../../../configuration/index.js";

/** Validated storage settings; connection ownership remains with infrastructure. */
export const postgresWorkflowsConfigBase = defineConfigBase(z.object({
  terminalPollIntervalMs: z.union([z.number(), z.string()]).pipe(z.coerce.number<string | number>().int().positive()).default(25),
}));
export type PostgresWorkflowsConfig = ConfigOutput<typeof postgresWorkflowsConfigBase>;
