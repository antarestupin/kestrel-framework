import { z } from "zod";

import {
  defineConfigBase,
  type ConfigOutput,
} from "../configuration/index.js";

const positiveInteger = z.union([z.number(), z.string()]).pipe(
  z.coerce.number<string | number>().int().positive(),
);
const port = positiveInteger.pipe(z.number().max(65_535));
const stableIdentifier = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);

const captureDriverConfigSchema = z.object({
  type: z.literal("capture"),
});

const memoryDriverConfigSchema = z.object({
  type: z.literal("memory"),
});

const smtpDriverConfigSchema = z.object({
  type: z.literal("smtp"),
  host: z.string().min(1),
  port: port.optional(),
  secure: z.boolean().default(false),
  requireTLS: z.boolean().default(true),
  allowInsecureAuth: z.boolean().default(false),
  auth: z.object({
    user: z.string().min(1),
    pass: z.string().min(1),
    method: z.enum(["plain", "login"]).optional(),
  }).optional(),
  heloName: z.string().min(1).optional(),
  timeoutMs: positiveInteger.default(15_000),
});

const sesDriverConfigSchema = z.object({
  type: z.literal("ses"),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  region: z.string().min(1),
  sessionToken: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
  charset: z.string().min(1).default("UTF-8"),
  configurationSetName: z.string().min(1).optional(),
});

const customDriverConfigSchema = z.object({
  type: z.literal("custom"),
  /** Stable name interpreted by an EmailProvider subclass. */
  name: stableIdentifier,
});

/** Built-in and extension dispatch configuration understood by EmailProvider. */
export const emailDriverConfigSchema = z.discriminatedUnion("type", [
  captureDriverConfigSchema,
  memoryDriverConfigSchema,
  smtpDriverConfigSchema,
  sesDriverConfigSchema,
  customDriverConfigSchema,
]);

/** General email configuration with capture retained as one driver concern. */
export const emailConfigBase = defineConfigBase(z.object({
  enabled: z.boolean().default(false),
  name: stableIdentifier.default("transactional"),
  driver: emailDriverConfigSchema.default({ type: "capture" }),
  capture: z.object({
    storage: z.enum(["memory", "postgres"]).default("postgres"),
    retentionDays: positiveInteger.default(7),
    maxMessageBytes: positiveInteger.default(10 * 1_024 * 1_024),
  }).default({
    storage: "postgres",
    retentionDays: 7,
    maxMessageBytes: 10 * 1_024 * 1_024,
  }),
}));

export type EmailConfig = ConfigOutput<typeof emailConfigBase>;
export type EmailDriverConfig = z.output<typeof emailDriverConfigSchema>;
export type SmtpEmailDriverConfig = z.output<typeof smtpDriverConfigSchema>;
export type SesEmailDriverConfig = z.output<typeof sesDriverConfigSchema>;
