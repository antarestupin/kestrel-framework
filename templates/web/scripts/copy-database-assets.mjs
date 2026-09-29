import { cp, mkdir, rm } from "node:fs/promises";

// TypeScript does not copy SQL or journals; compiled maintenance commands need the same history.
const destination = new URL("../dist/server/core/db/migrations/", import.meta.url);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(new URL("../src/server/core/db/migrations/", import.meta.url), destination, { recursive: true });
