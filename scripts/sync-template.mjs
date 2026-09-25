import { cp, mkdir, rm } from "node:fs/promises";

// The repository template is authoritative; generated package contents are disposable.
const target = new URL("../packages/create-kestrel/template/", import.meta.url);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(new URL("../templates/web/", import.meta.url), target, { recursive: true });
