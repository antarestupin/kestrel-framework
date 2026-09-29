import { defineConfig } from "vitest/config";

// Keep tests independent of the browser build root.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
