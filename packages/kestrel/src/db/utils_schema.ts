import { pgSchema } from "drizzle-orm/pg-core";

import { defineDatabaseSchemaDescription } from "./schema_contributions/descriptions.js";

/** PostgreSQL schema shared by reusable operational infrastructure tables. */
export const utilsSchema = defineDatabaseSchemaDescription(
  pgSchema("utils"),
  "Reusable operational infrastructure data.",
);
