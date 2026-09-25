#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

// Scaffolding writes into an empty directory and never installs dependencies implicitly.
const [directory, flag, archive, ...extra] = process.argv.slice(2);
if (!directory || flag !== "--framework-archive" || !archive || extra.length) {
  throw new Error("Usage: create-kestrel <directory> --framework-archive <local-framework.tgz>");
}
const destination = resolve(directory);
const name = basename(destination);
if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error("Use a lowercase npm-compatible directory name.");
const archivePath = resolve(archive);
await readFile(archivePath); // Fail before creating files if the archive is unavailable.
await mkdir(destination, { recursive: true });
if ((await readdir(destination)).length) throw new Error("The destination must be empty.");
await cp(new URL("../template/", import.meta.url), destination, { recursive: true });
await mkdir(resolve(destination, "vendor"));
await cp(archivePath, resolve(destination, "vendor/framework.tgz"));
const manifestPath = resolve(destination, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.name = name;
manifest.dependencies["@kestrel/framework"] = "file:vendor/framework.tgz";
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.info(`Created ${destination}. Run npm install, npm run build:ai, and npm run test:ai there.`);
