import { z } from "zod";

import {
  defineConfigBase,
  type ConfigOutput,
} from "../configuration/index.js";

const requiredString = z.string().min(1);
const databasePort = z.union([z.number(), z.string()]).pipe(
  z.coerce.number<string | number>().int().positive().max(65_535),
);

/** Configuration contract required by the PostgreSQL database library. */
export const databaseConfigBase = defineConfigBase(z.object({
  host: requiredString,
  port: databasePort.default(5432),
  user: requiredString,
  password: requiredString,
  database: requiredString,
  // Static application choices and raw environment variables are both valid
  // inputs; consumers always receive a boolean.
  ssl: z.union([z.boolean(), z.stringbool()]).default(true),
  queryObservability: z.object({
    parameters: z.enum(["include", "omit"]).default("omit"),
    origin: z.enum(["none", "caller", "stack"]).default("caller"),
  }).default({
    parameters: "omit",
    origin: "caller",
  }),
}));

export type DatabaseConfig = ConfigOutput<typeof databaseConfigBase>;
