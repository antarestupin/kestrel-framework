import { isIP } from "node:net";
import { z } from "zod";

import {
  defineConfigBase,
  type ConfigOutput,
} from "../../configuration/index.js";

const numericInput = z.union([z.number(), z.string()]);
const positiveInteger = numericInput.pipe(
  z.coerce.number<string | number>().int().positive(),
);
const httpOrigin = z.url().refine(
  (value) => {
    const url = new URL(value);

    return (url.protocol === "http:" || url.protocol === "https:")
      && value === url.origin;
  },
  { message: "An HTTP origin must contain only scheme, host, and optional port." },
);
const trustedProxyCidr = z.string().min(1).refine(
  isIpOrCidr,
  { message: "A trusted proxy must be an IP address or CIDR block." },
);

const httpHardeningConfigSchema = z.object({
  enabled: z.boolean().default(false),
  publicOrigins: z.array(httpOrigin).min(1),
  proxy: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("direct") }),
    z.object({
      mode: z.literal("trusted"),
      cidrs: z.array(trustedProxyCidr).min(1),
    }),
  ]),
  timeouts: z.object({
    connectionMs: positiveInteger.default(30_000),
    headersMs: positiveInteger.default(10_000),
    requestMs: positiveInteger.default(30_000),
    handlerMs: positiveInteger.default(30_000),
    keepAliveMs: positiveInteger.default(65_000),
    keepAliveBufferMs: positiveInteger.default(1_000),
  }).default({
    connectionMs: 30_000,
    headersMs: 10_000,
    requestMs: 30_000,
    handlerMs: 30_000,
    keepAliveMs: 65_000,
    keepAliveBufferMs: 1_000,
  }),
  limits: z.object({
    bodyBytes: positiveInteger.default(256 * 1_024),
    maxHeadersCount: positiveInteger.default(100),
    maxRequestsPerSocket: positiveInteger.default(1_000),
  }).default({
    bodyBytes: 256 * 1_024,
    maxHeadersCount: 100,
    maxRequestsPerSocket: 1_000,
  }),
  hsts: z.object({
    maxAgeSeconds: positiveInteger.default(31_536_000),
    includeSubDomains: z.boolean().default(false),
    preload: z.boolean().default(false),
  }).default({
    maxAgeSeconds: 31_536_000,
    includeSubDomains: false,
    preload: false,
  }),
}).check((context) => {
  const config = context.value;

  if (config.timeouts.headersMs > config.timeouts.requestMs) {
    context.issues.push({
      code: "custom",
      input: config.timeouts,
      message: "The header timeout cannot exceed the request timeout.",
      path: ["timeouts", "headersMs"],
    });
  }

  if (
    config.enabled
    && config.publicOrigins.some(
      (origin) => new URL(origin).protocol !== "https:",
    )
  ) {
    context.issues.push({
      code: "custom",
      input: config.publicOrigins,
      message: "An enabled HTTP hardening profile requires HTTPS public origins.",
      path: ["publicOrigins"],
    });
  }
});

/** Configuration contract for an application-selected HTTP hardening profile. */
export const httpHardeningConfigBase = defineConfigBase(
  httpHardeningConfigSchema,
);

export type HttpHardeningConfig = ConfigOutput<
  typeof httpHardeningConfigBase
>;

function isIpOrCidr(value: string): boolean {
  const separatorIndex = value.indexOf("/");

  if (separatorIndex === -1) {
    return isIP(value) !== 0;
  }

  // More than one slash cannot describe one CIDR prefix.
  if (separatorIndex !== value.lastIndexOf("/")) {
    return false;
  }

  const address = value.slice(0, separatorIndex);
  const prefix = value.slice(separatorIndex + 1);
  const family = isIP(address);
  const parsedPrefix = Number(prefix);
  const maxPrefix = family === 4 ? 32 : 128;

  return family !== 0
    && /^\d+$/u.test(prefix)
    && Number.isInteger(parsedPrefix)
    && parsedPrefix >= 0
    && parsedPrefix <= maxPrefix;
}
