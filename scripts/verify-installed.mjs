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
const manifestPath = require.resolve("@kestreljs/framework/package.json");
const packageRoot = dirname(manifestPath);
assert(packageRoot.includes("node_modules"), "An installed package is required, not a workspace link.");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
for (const [key, target] of Object.entries(manifest.exports)) {
  if (typeof target === "string") { await access(resolve(packageRoot, target)); continue; }
  await access(resolve(packageRoot, target.types));
  await access(resolve(packageRoot, target.import));
  const specifier = `@kestreljs/framework/${key.slice(2)}`;
  // Node 24 can require ESM, but tools such as Drizzle still need a matching export condition.
  const commonJs = require(specifier);
  const esm = await import(resolveModule(specifier));
  for (const name of Object.keys(esm)) assert.equal(commonJs[name], esm[name], `${specifier}: ${name}`);
}
const { default: Fastify } = await import(resolveModule("fastify"));
const { Studio, ViteStudioClientAdapter } = await import(resolveModule("@kestreljs/framework/studio"));
const { Atlas, ViteAtlasClientAdapter } = await import(resolveModule("@kestreljs/framework/atlas"));
// Exercise both relocated browser bundles from the independent installed archive.
for (const name of ["studio", "atlas"]) {
  const server = Fastify();
  try {
    const render = name === "studio"
      ? await new ViteStudioClientAdapter().setup(server, new Studio())
      : await new ViteAtlasClientAdapter().setup(server,
        new Atlas({ basePath: "/atlas", resources: [] }), { basePath: "/atlas", title: "Atlas" });
    server.get(`/${name}`, (_request, reply) => render(reply));
    const document = await server.inject(`/${name}`);
    assert.equal(document.statusCode, 200);
    assert(!document.body.includes(`/@fs/`), "Installed HTML must not reference checkout sources.");
    if (name === "atlas") {
      const config = document.body.match(/data-atlas-config="([^"]+)"/)?.[1];
      assert(config, "Atlas must receive application configuration.");
      assert.deepEqual(JSON.parse(decodeURIComponent(config)), { basePath: "/atlas", title: "Atlas" });
    }
    const assets = [...document.body.matchAll(/(?:src|href)="([^" ]+\.(?:js|css))"/gu)].map((match) => match[1]);
    assert(assets.some((url) => url.endsWith(".js")), `${name} must expose packaged JavaScript.`);
    assert(assets.some((url) => url.endsWith(".css")), `${name} must expose packaged styles.`);
    for (const url of assets) {
      assert(url.startsWith(`/_${name}_assets/`));
      const asset = await server.inject(url);
      assert.equal(asset.statusCode, 200, url);
      assert.match(asset.headers["content-type"], url.endsWith(".css") ? /css/u : /javascript/u);
      assert(asset.body.length > 0);
    }
  } finally { await server.close(); }
}
// The npm executable is a symlink; a missing application argument must report an error.
const executable = resolve(application, "node_modules/.bin/kestrel");
const result = spawnSync(process.execPath, [executable], { encoding: "utf8" });
assert.equal(result.status, 1);
assert.match(result.stderr, /An application module path is required/);
// Verify root tooling from outside the generated project, with real installed dependencies.
for (const file of ["do", ".devcontainer/ensure-test-database.sh"]) {
  assert((await stat(resolve(application, file))).mode & 0o111, `${file} must be executable`);
}
for (const file of [".gitignore", ".nvmrc", "AGENTS.md", ".vscode/settings.json", ".devcontainer/devcontainer.json", ".devcontainer/Dockerfile.drizzle-studio", ".devcontainer/Dockerfile.drizzle-studio.dockerignore", "drizzle.database.ts", "drizzle.dev.config.ts", "drizzle.dev-push.config.ts", "vite.development.config.ts", "src/server/example/example_catalog.ts", "src/server/core/development_clients.ts"]) {
  await access(resolve(application, file));
}
for (const file of ["src/server/main.ts", "src/server/generate.ts", "src/server/core/db/migrate.ts", "src/server/core/app_factory.ts", "src/server/core/config/environment.ts", "vite.config.ts"]) {
  await assert.rejects(access(resolve(application, file)), { code: "ENOENT" });
}
const generatedClient = resolve(application, "src/generated/public_client/public_client.ts");
const originalClient = await readFile(generatedClient, "utf8");
await rename(generatedClient, resolve(application, ".previous-generated-client.ts"));
// Production validates explicit credentials even for commands that never connect to PostgreSQL.
const productionEnvironment = {
  ENVIRONMENT: "prod", NODE_ENV: "production", KESTREL_COMPILED: "1",
  DB_HOST: "127.0.0.1", DB_USER: "fixture", DB_PASSWORD: "fixture", DB_DATABASE: "fixture",
  REDIS_URL: "redis://127.0.0.1:1/0",
};
for (const [launcher, args, environment] of [
  ["do", ["generate", "http-clients"], {}],
  ["do", ["--help"], {}],
  ["do", ["--help"], productionEnvironment],
]) {
  const invocation = spawnSync(resolve(application, launcher), args, {
    cwd: dirname(application), encoding: "utf8", env: { ...process.env, ...environment },
  });
  assert.equal(invocation.status, 0, invocation.stderr || invocation.error?.message);
}
assert.equal(await readFile(generatedClient, "utf8"), originalClient);
// Exercise the compiled application and its relocated browser assets without an HTTP listener.
const hasAtlas = (await readFile(resolve(application, "src/server/core/app.ts"), "utf8")).includes("new ApplicationAtlasProvider");
if (hasAtlas) {
  // The administration entry must be emitted alongside the server in an installed build.
  await access(resolve(application, "dist/admin/index.js"));
  await access(resolve(application, "dist/server/core/providers/atlas_provider.js"));
}
// Check both exposure states against the real compiled composition and SPA fallback.
for (const atlasEnabled of hasAtlas ? [false, true] : [false]) {
  const browserCheck = spawnSync(process.execPath, ["--import", "zod/compile", "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import app from "./dist/server/core/app.js";
    import { httpRuntimeDependency } from "@kestreljs/framework/http";
    // A configured Redis cache must not connect while serving routes that never use it.
    app.container.registerFactory("redisCacheConnection", () => { throw new Error("Redis must remain lazy."); });
    const runtime = app.container.resolve(httpRuntimeDependency);
    try {
      const document = await runtime.server.inject("/");
      assert.equal(document.statusCode, 200);
      const entry = document.body.match(/src="([^\"]+\\.js)"/)?.[1];
      assert(entry, "The application must expose its compiled browser entry.");
      assert.equal((await runtime.server.inject(entry)).statusCode, 200);
      // Explicitly enable Studio to verify both packaged browser scopes coexist.
      const studioDocument = await runtime.server.inject("/_studio");
      assert.equal(studioDocument.statusCode, 200);
      const studioEntry = studioDocument.body.match(/src="([^\"]+\\.js)"/)?.[1];
      assert(studioEntry, "Studio must expose its own packaged browser entry.");
      assert.notEqual(studioEntry, entry);
      assert.equal((await runtime.server.inject(studioEntry)).statusCode, 200);
      const studioManifest = await runtime.server.inject("/_studio/api/manifest");
      assert.equal(studioManifest.statusCode, 200);
      assert.equal(studioManifest.json().extensions.some((extension) => extension.id === "controllers"), true);
      if (${atlasEnabled}) {
        // The generated composition must serve Atlas alongside both other browser clients.
        const atlasDocument = await runtime.server.inject("/admin");
        assert.equal(atlasDocument.statusCode, 200);
        const atlasEntry = atlasDocument.body.match(/src="([^\"]+\\.js)"/)?.[1];
        assert(atlasEntry?.startsWith("/_atlas_assets/"));
        assert.equal((await runtime.server.inject(atlasEntry)).statusCode, 200);
        const atlasManifest = await runtime.server.inject("/admin/api/manifest");
        assert.equal(atlasManifest.statusCode, 200);
        assert.deepEqual(atlasManifest.json().resources, []);
      } else if (${hasAtlas}) {
        for (const path of ["/admin", "/admin/api/manifest", "/_atlas_assets/missing.js"]) {
          assert.equal((await runtime.server.inject(path)).statusCode, 404, path);
        }
      }
      const response = await runtime.server.inject("/api/greet?name=Sam");
      assert.deepEqual(response.json(), { message: "Hello, Sam!" });
      assert.equal(response.headers["x-request-id"] !== undefined, true);
    } finally {
      try { await runtime.stop(); } finally { await app.dispose(); }
    }
  `], {
    cwd: application, encoding: "utf8",
    env: {
      ...process.env,
      ...productionEnvironment,
      APP_CONFIG__HTTP__EXECUTION_ID_HEADER: "x-request-id",
      APP_CONFIG__STUDIO__ENABLED: "true",
      ...(hasAtlas ? { APP_CONFIG__BACKOFFICE__ENABLED: String(atlasEnabled) } : {}),
    },
  });
  assert.equal(browserCheck.status, 0, browserCheck.stderr || browserCheck.error?.message);
}
for (const file of ["0000_initial_note.sql", "meta/_journal.json", "meta/0000_snapshot.json"]) {
  assert.equal(
    await readFile(resolve(application, "dist/server/core/db/migrations", file), "utf8"),
    await readFile(resolve(application, "src/server/core/db/migrations", file), "utf8"),
  );
}
console.info(`Verified ${Object.keys(manifest.exports).length} ESM/CommonJS exports, declarations, CLI symlink, and Atlas/Studio assets from ${fileURLToPath(pathToFileURL(packageRoot))}.`);
console.info("Verified starter root tooling, CLI entry points, client regeneration, compiled browser delivery, configuration overrides, and migration assets.");
