import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { generateDatabaseMigration } from "@kestrel/framework/db";
import * as schema from "./schema/app_schema.js";

// Preserve Drizzle's interactive diff and collect Kestrel schema contributions in the same history.
const require = createRequire(import.meta.url);
await generateDatabaseMigration({
  cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
  drizzleArguments: process.argv.slice(2),
  drizzleKitExecutable: process.execPath,
  drizzleKitExecutableArguments: [join(dirname(require.resolve("drizzle-kit/api")), "bin.cjs")],
  migrationsFolder: fileURLToPath(new URL("./migrations", import.meta.url)),
  schema,
});
