import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "./release/common.mjs";

const directory = resolve(process.argv[2]);
// All imports below resolve from the isolated deployment, which has no source checkout.
await assert.rejects(access(resolve(directory, "src")), { code: "ENOENT" });
await assert.rejects(access(resolve(directory, "node_modules/typescript")), { code: "ENOENT" });
const resolver = resolve(directory, ".resolver.mjs");
await writeFile(resolver, "export const resolveModule = (name) => import.meta.resolve(name);\n");
const { resolveModule } = await import(pathToFileURL(resolver));
const { default: pg } = await import(resolveModule("pg"));
const hasAtlas = JSON.parse(await readFile(resolve(directory, "package.json"))).kestrelReleaseAtlas === true;
const database = `kestrel_release_${randomUUID().replaceAll("-", "")}`;
const config = {
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? process.env.KESTREL_POSTGRES_PORT ?? 55432),
  user: process.env.DB_USER ?? "postgres", password: process.env.DB_PASSWORD ?? "postgres",
};
const maintenance = new pg.Pool({ ...config, database: "postgres", connectionTimeoutMillis: 10000 });
let created = false;
try {
  // This script owns only its unpredictable temporary database, never application/test databases.
  await maintenance.query(`CREATE DATABASE "${database}"`);
  created = true;
  const env = { ...process.env, ENVIRONMENT: "prod", NODE_ENV: "production", KESTREL_COMPILED: "1", LOG_LEVEL: "silent",
    DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user, DB_PASSWORD: config.password,
    DB_DATABASE: database, DB_SSL: "false", APP_CONFIG__STUDIO__ENABLED: "true",
    ...(hasAtlas ? { APP_CONFIG__BACKOFFICE__ENABLED: "true" } : {}), REDIS_URL: "redis://127.0.0.1:1/0" };
  const cli = resolve(directory, "node_modules/@kestreljs/framework/dist/cli/main.js");
  // Run the public compiled migration command twice: first application and repeat safety.
  for (let attempt = 0; attempt < 2; attempt++) {
    await run(process.execPath, ["--import", "zod/compile", cli, "dist/server/core/app.js", "database", "migrate"], { cwd: directory, env });
  }
  const pool = new pg.Pool({ ...config, database, connectionTimeoutMillis: 10000 });
  try { assert.equal((await pool.query("SELECT count(*) FROM note")).rows[0].count, "0"); }
  finally { await pool.end(); }
  // Boot and HTTP injection exercise production composition without opening a listener.
  await run(process.execPath, ["--import", "zod/compile", "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import app from "./dist/server/core/app.js";
    import { httpRuntimeDependency } from "@kestreljs/framework/http";
    const runtime = app.container.resolve(httpRuntimeDependency);
    try {
      const response = await runtime.server.inject("/api/greet?name=Production");
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { message: "Hello, Production!" });
      for (const path of ${JSON.stringify(["/", "/_studio"]) }.concat(${hasAtlas} ? ["/admin"] : [])) {
        const document = await runtime.server.inject(path);
        assert.equal(document.statusCode, 200, path);
        assert(!document.body.includes("/@fs/"));
        const assets = [...document.body.matchAll(/(?:src|href)="([^" ]+\\.(?:js|css))"/gu)].map((match) => match[1]);
        assert(assets.some((url) => url.endsWith(".js")), path);
        for (const url of assets) {
          const asset = await runtime.server.inject(url);
          assert.equal(asset.statusCode, 200, url);
          assert.match(asset.headers["content-type"], url.endsWith(".css") ? /css/u : /javascript/u);
        }
      }
    } finally { try { await runtime.stop(); } finally { await app.dispose(); } }
  `], { cwd: directory, env });
} finally {
  try { if (created) await maintenance.query(`DROP DATABASE "${database}"`); }
  finally { await maintenance.end(); }
}
console.info("Production-only deployment, compiled migrations, HTTP injection, and browser assets verified.");
