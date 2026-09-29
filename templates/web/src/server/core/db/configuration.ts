import { databaseConfigBase } from "@kestrel/framework/db/configuration";
import { readEnvironment } from "../environment.js";

/** Share database credentials between the application and Drizzle without bootstrapping providers. */
export function readDatabaseConfig() {
  const environment = readEnvironment();
  return databaseConfigBase.schema.parse({
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: process.env.DB_PORT ?? 55432,
    user: process.env.DB_USER ?? "postgres",
    password: process.env.DB_PASSWORD ?? "postgres",
    database: environment === "test"
      ? process.env.DB_TEST_DATABASE ?? "kestrel_playground_test"
      : process.env.DB_DATABASE ?? "kestrel_playground",
    ssl: process.env.DB_SSL ?? false,
  });
}
