import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../../../configuration/index.js";
const positiveInteger = z
  .union([z.number(), z.string()])
  .pipe(z.coerce.number<string | number>().int().positive());
/** Backend-specific settings, validated at the application configuration boundary. */
export const captureEmailConfigBase = defineConfigBase(
  z.object({ maxMessageBytes: positiveInteger.default(10 * 1024 * 1024) }),
);
export type CaptureEmailConfig = ConfigOutput<typeof captureEmailConfigBase>;
