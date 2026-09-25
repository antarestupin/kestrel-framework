import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { readAppConfig } from "../appConfig.js";

// Apply only this application's fresh migration history and always release the connection pool.
const pool = new Pool(readAppConfig().database);
try {
  await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../../../../migrations", import.meta.url)) });
} finally {
  await pool.end();
}
