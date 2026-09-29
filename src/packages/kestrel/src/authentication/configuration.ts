import { z } from "zod";

import {
  defineConfigBase,
  type ConfigOutput,
} from "../configuration/index.js";

const numericInput = z.union([z.number(), z.string()]);
const positiveInteger = numericInput.pipe(
  z.coerce.number<string | number>().int().positive(),
);
const tokenBytes = numericInput.pipe(
  z.coerce.number<string | number>().int().min(32),
);
const sameSiteSchema = z.enum(["lax", "strict"]);

const authenticationConfigSchema = z.object({
  session: z.object({
    tokenBytes: tokenBytes.default(32),
    idleTtlSeconds: positiveInteger.default(86_400),
    absoluteTtlSeconds: positiveInteger.default(604_800),
    touchIntervalSeconds: positiveInteger.default(300),
    maxClaimsBytes: positiveInteger.default(4_096),
  }),
  mechanisms: z.object({
    password: z.object({
      minLength: positiveInteger.default(12),
      maxLength: positiveInteger.default(1_024),
    }),
  }),
  http: z.object({
    cookie: z.object({
      name: z.string().min(1).default("__Host-session"),
      secure: z.boolean().default(true),
      sameSite: sameSiteSchema.default("lax"),
      path: z.literal("/").default("/"),
    }),
    trustedOrigins: z.array(z.url()).min(1),
  }),
}).check((context) => {
  const config = context.value;

  if (config.session.idleTtlSeconds > config.session.absoluteTtlSeconds) {
    context.issues.push({
      code: "custom",
      input: config,
      message: "Session idle TTL cannot exceed its absolute TTL.",
      path: ["session", "idleTtlSeconds"],
    });
  }

  if (config.session.touchIntervalSeconds > config.session.idleTtlSeconds) {
    context.issues.push({
      code: "custom",
      input: config,
      message: "Session touch interval cannot exceed its idle TTL.",
      path: ["session", "touchIntervalSeconds"],
    });
  }

  if (
    config.mechanisms.password.minLength
      > config.mechanisms.password.maxLength
  ) {
    context.issues.push({
      code: "custom",
      input: config,
      message: "Password minimum length cannot exceed its maximum length.",
      path: ["mechanisms", "password", "minLength"],
    });
  }

  if (
    config.http.cookie.name.startsWith("__Host-")
      && !config.http.cookie.secure
  ) {
    context.issues.push({
      code: "custom",
      input: config,
      message: "__Host- cookies require secure transport.",
      path: ["http", "cookie", "secure"],
    });
  }
});

/** Storage-neutral authentication and HTTP session policy. */
export const authenticationConfigBase = defineConfigBase(
  authenticationConfigSchema,
);

export type AuthenticationConfig = ConfigOutput<
  typeof authenticationConfigBase
>;
