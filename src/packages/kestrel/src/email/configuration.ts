import { z } from "zod";
import { defineConfigBase, type ConfigOutput } from "../configuration/index.js";

/** Shared email policy; transport and capture settings belong to their adapters. */
export const emailConfigBase = defineConfigBase(z.object({
  enabled: z.boolean().default(false),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u).default("transactional"),
}));
export type EmailConfig = ConfigOutput<typeof emailConfigBase>;
