import type { ConnectionOptions } from "node:tls";
import type { PoolConfig } from "pg";
import { z } from "zod";

import { defineConfigBase, type ConfigOutput } from "../configuration/index.js";

const requiredString = z.string().min(1);
const integer = z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(
  z.coerce.number<string | number>().int().nonnegative().max(2_147_483_647),
);
const positiveInteger = integer.refine((value) => value > 0, "Must be positive");
const boolean = z.union([z.boolean(), z.stringbool()]);
const certificate = z.union([z.string(), z.instanceof(Buffer)]);

/** Validate common TLS settings while preserving Node's advanced TLS options. */
const tls = z.looseObject({
  rejectUnauthorized: boolean.default(true),
  ca: z.union([certificate, z.array(certificate)]).optional(),
  cert: z.union([certificate, z.array(certificate)]).optional(),
  key: z.union([certificate, z.array(z.union([
    certificate,
    z.object({ pem: certificate, passphrase: z.string().optional() }),
  ]))]).optional(),
  servername: z.string().optional(),
  passphrase: z.string().optional(),
}).transform((value) => value as ConnectionOptions);

/** Native pg options stay native; Kestrel policies are kept in their own namespace. */
export const postgresDrizzleConfigBase = defineConfigBase(z.looseObject({
  host: requiredString,
  port: positiveInteger.refine((value) => value <= 65_535).default(5432),
  user: requiredString,
  password: requiredString,
  database: requiredString,
  ssl: z.union([boolean, tls]).default(true),
  max: positiveInteger.default(10),
  min: integer.default(0),
  connectionTimeoutMillis: positiveInteger.default(5_000),
  idleTimeoutMillis: integer.default(30_000),
  statement_timeout: integer.default(30_000),
  lock_timeout: integer.default(5_000),
  idle_in_transaction_session_timeout: integer.default(10_000),
  // pg forwards startup options verbatim; applications can replace this for maintenance.
  options: z.string().default("-c transaction_timeout=60000"),
  query_timeout: integer.default(35_000),
  // pg multiplies seconds by 1000 before scheduling a Node timer.
  maxLifetimeSeconds: integer.refine((value) => value <= 2_147_483).optional(),
  maxUses: positiveInteger.optional(),
  application_name: z.string().optional(),
  keepAlive: boolean.optional(),
  keepAliveInitialDelayMillis: integer.optional(),
  allowExitOnIdle: boolean.optional(),
  resourcePolicy: z.object({
    maxWaitingRequests: integer.default(100),
    shutdownTimeoutMs: positiveInteger.default(10_000),
  }).prefault({}),
  queryObservability: z.object({
    parameters: z.enum(["include", "omit"]).default("omit"),
    origin: z.enum(["none", "caller", "stack"]).default("caller"),
  }).prefault({}),
}).refine((value) => value.min <= value.max, {
  path: ["min"], message: "min must not exceed max",
}));

// Additional driver options (type parsers, connection hooks, etc.) remain available.
export type PostgresDrizzleConfig = ConfigOutput<typeof postgresDrizzleConfigBase>
  & PoolConfig;
