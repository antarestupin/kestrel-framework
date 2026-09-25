import { defineConfig } from "drizzle-kit";

export default defineConfig({ dialect: "postgresql", schema: "./src/server/core/db/schema.ts", out: "./migrations" });
