import { z } from "zod";
import { databaseConfigBase } from "@kestrel/framework/db";
import { loggerConfigBase } from "@kestrel/framework/log";

/** Environment interpretation belongs to the application, not the framework. */
export function readAppConfig() {
  return {
    devMode: process.env.NODE_ENV !== "production",
    port: z.coerce.number().int().min(0).max(65535).parse(process.env.PORT ?? 3333),
    database: databaseConfigBase.schema.parse({
      host: process.env.DB_HOST ?? "127.0.0.1",
      port: process.env.DB_PORT ?? 55432,
      user: process.env.DB_USER ?? "postgres", password: process.env.DB_PASSWORD ?? "postgres",
      database: process.env.DB_DATABASE ?? "kestrel_playground",
      ssl: process.env.DB_SSL ?? false,
    }),
    logger: loggerConfigBase.schema.parse({ level: process.env.LOG_LEVEL ?? "info" }),
  };
}
