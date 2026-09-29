import { z } from "zod";

import {
  defineConfigBase,
  type ConfigOutput,
} from "../configuration/index.js";
import { httpClientGenerationConfigSchema } from "./client_generation/configuration.js";

const httpPort = z.union([z.number(), z.string()]).pipe(
  z.coerce.number<string | number>().int().min(0).max(65_535),
);

/** Configuration contract required by the HTTP runtime. */
export const httpConfigBase = defineConfigBase(z.object({
  host: z.string().min(1).default("0.0.0.0"),
  port: httpPort.default(3_333),
  fastifyLogs: z.boolean(),
  // RFC 9110 field names use the HTTP token character set.
  executionIdHeader: z.string()
    .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u)
    .default("x-execution-id"),
  clientGeneration: httpClientGenerationConfigSchema,
}));

export type HttpConfig = ConfigOutput<typeof httpConfigBase>;
