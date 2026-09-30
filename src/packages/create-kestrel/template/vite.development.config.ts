// Configures the shared Vite development graph for browser code and generated HTTP contracts.
// Adjust development plugins and file access here; production uses src/client/vite.config.ts.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

// One development graph serves the client and its generated contracts from the project root.
export default defineConfig({
  root: projectRoot,
  cacheDir: ".vite/development",
  server: { fs: { allow: [projectRoot] } },
  optimizeDeps: { entries: ["src/client/src/main.tsx"] },
  plugins: [react()],
});
