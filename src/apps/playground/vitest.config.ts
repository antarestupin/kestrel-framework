// Configures discovery of application tests independently of the browser build root.
// Add shared test options here and keep tests compatible with --no-isolate.

import { defineConfig } from "vitest/config";

// Keep tests independent of the browser build root.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
