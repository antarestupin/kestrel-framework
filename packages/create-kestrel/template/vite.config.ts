import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fastifyVite from "@fastify/vite/plugin";

export default defineConfig({
  root: fileURLToPath(new URL("./src/client", import.meta.url)), base: "/_client_assets/",
  build: { outDir: fileURLToPath(new URL("./dist/web", import.meta.url)), emptyOutDir: true },
  plugins: [fastifyVite({ spa: true }), react()],
});
