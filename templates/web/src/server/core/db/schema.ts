import { pgTable, text, uuid } from "drizzle-orm/pg-core";

// Application-owned singular table; framework storage is composed separately when needed.
export const note = pgTable("note", { id: uuid("id").primaryKey().defaultRandom(), content: text("content").notNull() });
