// Declares the application database tables included in deployment migrations.
// Add singular table definitions here, then generate a migration with npm run db:generate.

import { pgTable, text, uuid } from "drizzle-orm/pg-core";

// Application-owned singular table; framework storage is composed separately when needed.
export const note = pgTable("note", { id: uuid("id").primaryKey().defaultRandom(), content: text("content").notNull() });
