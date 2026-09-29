import { z } from "zod";
import { loggerConfigBase } from "@kestrel/framework/log";
import { readDatabaseConfig } from "./db/configuration.js";
import { readEnvironment } from "./environment.js";

/** Environment interpretation belongs to the application, not the framework. */
export function readAppConfig() {
  const environment = readEnvironment();
  return {
    environment,
    devMode: environment === "local",
    host: process.env.HOST ?? "127.0.0.1",
    port: z.coerce.number().int().min(0).max(65535).parse(process.env.PORT ?? 3333),
    database: readDatabaseConfig(),
    logger: loggerConfigBase.schema.parse({ level: process.env.LOG_LEVEL ?? "info" }),
  };
}

export type AppConfig = ReturnType<typeof readAppConfig>;
