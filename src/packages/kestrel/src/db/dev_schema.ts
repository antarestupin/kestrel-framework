import { pgSchema } from "drizzle-orm/pg-core";

import { defineDatabaseSchemaDescription } from "./schema_contributions/descriptions.js";

/** PostgreSQL schema containing disposable local-development data. */
export const devSchema = defineDatabaseSchemaDescription(
  pgSchema("dev"),
  "Disposable data used by local-development tools and diagnostics.",
);
