import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../../../configuration/index.js";
const positiveInteger = z
  .union([z.number(), z.string()])
  .pipe(z.coerce.number<string | number>().int().positive());
const port = positiveInteger.pipe(z.number().max(65_535));
export const smtpEmailConfigBase = defineConfigBase(
  z.object({
    host: z.string().min(1),
    port: port.optional(),
    secure: z.boolean().default(false),
    requireTLS: z.boolean().default(true),
    allowInsecureAuth: z.boolean().default(false),
    auth: z
      .object({
        user: z.string().min(1),
        pass: z.string().min(1),
        method: z.enum(["plain", "login"]).optional(),
      })
      .optional(),
    heloName: z.string().min(1).optional(),
    timeoutMs: positiveInteger.default(15_000),
  }),
);
export type SmtpEmailConfig = ConfigOutput<typeof smtpEmailConfigBase>;
