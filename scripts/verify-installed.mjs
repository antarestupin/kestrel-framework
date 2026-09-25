import assert from "node:assert/strict";
import { readFile, access, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Resolve every dependency from an independently installed application, never this workspace.
const application = process.argv[2];
if (!application) throw new Error("Pass the installed application directory.");
const require = createRequire(pathToFileURL(resolve(application, "package.json")));
const resolverPath = resolve(application, ".kestrel-package-resolver.mjs");
await writeFile(resolverPath, "export const resolveModule = (specifier) => import.meta.resolve(specifier);\n");
const { resolveModule } = await import(pathToFileURL(resolverPath).href);
const manifestPath = require.resolve("@kestrel/framework/package.json");
const packageRoot = dirname(manifestPath);
assert(packageRoot.includes("node_modules"), "An installed package is required, not a workspace link.");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
for (const [key, target] of Object.entries(manifest.exports)) {
  if (typeof target === "string") { await access(resolve(packageRoot, target)); continue; }
  await access(resolve(packageRoot, target.types));
  await access(resolve(packageRoot, target.import));
  const specifier = `@kestrel/framework/${key.slice(2)}`;
  // Node 24 can require ESM, but tools such as Drizzle still need a matching export condition.
  const commonJs = require(specifier);
  const esm = await import(resolveModule(specifier));
  for (const name of Object.keys(esm)) assert.equal(commonJs[name], esm[name], `${specifier}: ${name}`);
}
const { default: Fastify } = await import(resolveModule("fastify"));
const { Studio, ViteStudioClientAdapter } = await import(resolveModule("@kestrel/framework/studio"));
const server = Fastify();
try {
  const render = await new ViteStudioClientAdapter().setup(server, new Studio());
  server.get("/studio", (_request, reply) => render(reply));
  const document = await server.inject("/studio");
  assert.equal(document.statusCode, 200);
  const entry = document.body.match(/src="([^\"]+\.js)"/)?.[1];
  assert(entry, "Studio must expose a packaged browser entry.");
  assert.equal((await server.inject(entry)).statusCode, 200);
} finally { await server.close(); }
// The npm executable is a symlink; a missing application argument must report an error.
const executable = resolve(application, "node_modules/.bin/kestrel");
const result = spawnSync(process.execPath, [executable], { encoding: "utf8" });
assert.equal(result.status, 1);
assert.match(result.stderr, /An application module path is required/);
console.info(`Verified ${Object.keys(manifest.exports).length} ESM/CommonJS exports, declarations, CLI symlink, and Studio assets from ${fileURLToPath(pathToFileURL(packageRoot))}.`);
