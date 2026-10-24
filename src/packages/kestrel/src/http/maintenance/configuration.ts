import { z } from "zod";

// Match raw URL paths, without query strings or implicit wildcard expansion.
const maintenancePathSchema = z.string().regex(
  /^\/(?!\/)[^?#\\\s*]*$/u,
  "A maintenance path must start with / and contain no query, fragment, whitespace, backslash or wildcard.",
);

const maintenanceExceptionSchema = z.object({
  path: maintenancePathSchema,
  // Omitting methods allows every method on this exact path.
  methods: z.array(z.enum([
    "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT",
  ])).min(1).optional(),
});

/** Startup-only HTTP admission settings, independent of application services. */
export const httpMaintenanceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  retryAfterSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  // Trusted application HTML is served verbatim; no request data is interpolated.
  html: z.string().refine((html) => html.trim().length > 0, {
    message: "The maintenance HTML cannot be empty.",
  }).optional(),
  apiPathPrefixes: z.array(maintenancePathSchema).default(["/api"]),
  exceptions: z.array(maintenanceExceptionSchema).default([]),
});

export type HttpMaintenanceConfig = z.output<typeof httpMaintenanceConfigSchema>;
export type HttpMaintenanceException = z.output<typeof maintenanceExceptionSchema>;
