import { z } from "zod";

import {
  defineConfigBase,
  type ConfigOutput,
} from "../configuration/index.js";

/** Configuration contract required by the application logger provider. */
export const loggerConfigBase = defineConfigBase(z.object({
  level: z.string().min(1).default("info"),
  developmentStorage: z.boolean().default(false),
  executionLog: z.object({
    enabled: z.union([z.boolean(), z.stringbool()]).default(true),
    contextMode: z.enum(["completion", "dynamic"]).default("completion"),
  }).default({
    enabled: true,
    contextMode: "completion",
  }),
}));

export type LoggerConfig = ConfigOutput<typeof loggerConfigBase>;
