import { z } from "zod";

import type { AtlasClientEffect } from "./contract.js";

/** Validates every effect before it crosses the gateway boundary. */
export const atlasClientEffectSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("redirect"),
    target: z.object({
      resource: z.string().min(1),
      recordId: z.string(),
    }),
  }),
  z.object({
    type: z.literal("notification"),
    level: z.enum(["success", "info", "warning", "error"]),
    message: z.string().min(1),
    link: z.object({
      label: z.string().min(1),
      target: z.object({
        resource: z.string().min(1),
        recordId: z.string(),
      }),
    }).optional(),
  }),
]);

/** Creates a redirect effect without exposing its wire representation. */
export function atlasRedirect(
  target: Extract<AtlasClientEffect, { type: "redirect" }>["target"],
): AtlasClientEffect {
  return { type: "redirect", target };
}

/** Creates a notification effect without exposing its discriminator. */
export function atlasNotification(
  options: Omit<
    Extract<AtlasClientEffect, { type: "notification" }>,
    "type"
  >,
): AtlasClientEffect {
  return { type: "notification", ...options };
}
