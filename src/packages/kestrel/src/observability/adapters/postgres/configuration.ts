import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../../../configuration/index.js";
const positiveInteger = z
  .union([z.number(), z.string()])
  .pipe(z.coerce.number<string | number>().int().positive());
/** Backend-specific settings, validated at the application configuration boundary. */
export const postgresObservationsConfigBase = defineConfigBase(
  z.object({ retentionDays: positiveInteger.default(7) }),
);
export type PostgresObservationsConfig = ConfigOutput<typeof postgresObservationsConfigBase>;
