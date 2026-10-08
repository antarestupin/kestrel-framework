import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../../../configuration/index.js";
const positiveInteger = z
  .union([z.number(), z.string()])
  .pipe(z.coerce.number<string | number>().int().positive());
const port = positiveInteger.pipe(z.number().max(65_535));
export const sesEmailConfigBase = defineConfigBase(
  z.object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    region: z.string().min(1),
    sessionToken: z.string().min(1).optional(),
    baseUrl: z.url().optional(),
    charset: z.string().min(1).default("UTF-8"),
    configurationSetName: z.string().min(1).optional(),
  }),
);
export type SesEmailConfig = ConfigOutput<typeof sesEmailConfigBase>;
