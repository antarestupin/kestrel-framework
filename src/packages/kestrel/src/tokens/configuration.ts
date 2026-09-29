import { z } from "zod";

import {
  defineConfigBase,
  type ConfigOutput,
} from "../configuration/index.js";

const positiveInteger = z.union([z.number(), z.string()]).pipe(
  z.coerce.number<string | number>().int().positive(),
);

/** Configuration shared by the bundled opaque stored-token strategy. */
export const tokensConfigBase = defineConfigBase(z.object({
  stored: z.object({
    tokenBytes: positiveInteger.pipe(z.number().min(32)).default(32),
    maxPayloadBytes: positiveInteger.default(4_096),
  }),
}));

export type TokensConfig = ConfigOutput<typeof tokensConfigBase>;
