import fastifyVite from "@fastify/vite/plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Browser assets are built once and relocated with the installed package.
export default defineConfig({
  root: fileURLToPath(new URL("./src/studio/client", import.meta.url)),
  base: "/_studio_assets/",
  build: { outDir: fileURLToPath(new URL("./assets/studio", import.meta.url)), emptyOutDir: true },
  plugins: [fastifyVite({ spa: true }), react()],
});
