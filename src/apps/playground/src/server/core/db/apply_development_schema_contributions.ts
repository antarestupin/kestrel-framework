import { Pool } from "pg";
import { applyDatabaseSchemaContributions } from "@kestrel/framework/db";
import { readEnvironment } from "../environment.js";
import { readDatabaseConfig } from "./configuration.js";
import * as schema from "./schema/push_schema.js";

if (readEnvironment() !== "local") throw new Error("Development schema contributions require the local environment.");

// Drizzle Push does not install Kestrel contributions, so apply them after synchronization.
const pool = new Pool(readDatabaseConfig());
try {
  await applyDatabaseSchemaContributions(schema, async (statement) => pool.query(statement));
} finally {
  await pool.end();
}
