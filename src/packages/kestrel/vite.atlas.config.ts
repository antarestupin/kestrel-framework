import fastifyVite from "@fastify/vite/plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Browser assets are built once and relocated with the installed package.
export default defineConfig({
  root: fileURLToPath(new URL("./src/atlas/client", import.meta.url)),
  base: "/_atlas_assets/",
  build: { outDir: fileURLToPath(new URL("./assets/atlas", import.meta.url)), emptyOutDir: true },
  plugins: [fastifyVite({ spa: true }), react()],
});
