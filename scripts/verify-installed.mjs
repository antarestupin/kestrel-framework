import assert from "node:assert/strict";
import { readFile, access, writeFile, rename, stat } from "node:fs/promises";
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
// Verify root tooling from outside the generated project, with real installed dependencies.
for (const file of ["do", ".devcontainer/ensure-test-database.sh"]) {
  assert((await stat(resolve(application, file))).mode & 0o111, `${file} must be executable`);
}
for (const file of [".gitignore", ".nvmrc", "AGENTS.md", ".vscode/settings.json", ".devcontainer/devcontainer.json", "drizzle.database.ts", "drizzle.dev.config.ts", "drizzle.dev-push.config.ts", "vite.development.config.ts"]) {
  await access(resolve(application, file));
}
for (const file of ["src/server/main.ts", "src/server/generate.ts", "src/server/core/db/migrate.ts"]) {
  await assert.rejects(access(resolve(application, file)), { code: "ENOENT" });
}
const generatedClient = resolve(application, "src/generated/publicClient/publicClient.ts");
const originalClient = await readFile(generatedClient, "utf8");
await rename(generatedClient, resolve(application, ".previous-generated-client.ts"));
for (const [launcher, args, environment] of [
  ["do", ["generate", "http-clients"], {}],
  ["do", ["--help"], {}],
  ["do", ["--help"], { NODE_ENV: "production", KESTREL_COMPILED: "1" }],
]) {
  const invocation = spawnSync(resolve(application, launcher), args, {
    cwd: dirname(application), encoding: "utf8", env: { ...process.env, ...environment },
  });
  assert.equal(invocation.status, 0, invocation.stderr || invocation.error?.message);
}
assert.equal(await readFile(generatedClient, "utf8"), originalClient);
for (const file of ["0000_initial_note.sql", "meta/_journal.json", "meta/0000_snapshot.json"]) {
  assert.equal(
    await readFile(resolve(application, "dist/server/core/db/migrations", file), "utf8"),
    await readFile(resolve(application, "src/server/core/db/migrations", file), "utf8"),
  );
}
console.info(`Verified ${Object.keys(manifest.exports).length} ESM/CommonJS exports, declarations, CLI symlink, and Studio assets from ${fileURLToPath(pathToFileURL(packageRoot))}.`);
console.info("Verified starter root tooling, source and compiled CLI entry points, client regeneration, and compiled migration assets.");
