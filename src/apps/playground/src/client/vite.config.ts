// Configures the production browser build, asset base path, plugins, and dist/client output.
// Development HMR uses the root vite.development.config.ts instead.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fastifyVite from "@fastify/vite/plugin";
import { DEFAULT_CLIENT_ASSET_BASE_PATH } from "@kestreljs/framework/client";

// The browser owns its production build configuration and output directory.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: fileURLToPath(new URL("./.vite", import.meta.url)),
  base: DEFAULT_CLIENT_ASSET_BASE_PATH,
  build: {
    outDir: fileURLToPath(new URL("../../dist/client", import.meta.url)),
    emptyOutDir: true,
  },
  plugins: [fastifyVite({ spa: true }), react()],
});
