import { access, mkdtemp, mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { createEnv } from "yeoman-environment";
import { parse } from "yaml";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { cacheEntries } from "../kestrel/src/cache/postgres_schema.js";
import { utilsSchema } from "../kestrel/src/db/utils_schema.js";
import { getDatabaseSchemaContributions } from "../kestrel/src/db/schema_contributions/index.js";
import { note } from "./template/src/server/core/db/schema/app_schema.js";
import { createApplication } from "./generators/index.mjs";

const executable = fileURLToPath(new URL("./bin/create.mjs", import.meta.url));

/** Each invocation owns its destination and archive; no test starts application infrastructure. */
async function withFixture(run: (fixture: { root: string; target: string; archive: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "kestrel-creator-"));
  try {
    const archive = join(root, "framework.tgz");
    await writeFile(archive, "local fixture archive");
    await run({ root, target: join(root, "my-app"), archive });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function create(target: string, archive: string, ...arguments_: string[]) {
  return spawnSync(process.execPath, [executable, target, "--framework-archive", archive, ...arguments_], {
    encoding: "utf8", timeout: 10_000,
  });
}

it.each([
  { cache: "postgres", insight: false },
  { cache: "redis", insight: false },
  { cache: "redis", insight: true },
])("composes $cache cache with Redis Insight=$insight", async ({ cache, insight }) => {
  await withFixture(async ({ target, archive }) => {
    const result = create(target, archive, "--cache", cache, insight ? "--redis-insight" : "--no-redis-insight");
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    const infrastructure = parse(await readFile(join(target, ".devcontainer/docker-compose.yml"), "utf8"));
    expect(manifest.name).toBe("my-app");
    expect(manifest.dependencies["@kestrel/framework"]).toBe("file:vendor/framework.tgz");
    expect(manifest.dependencies["yeoman-generator"]).toBeUndefined();
    expect(await readFile(join(target, "vendor/framework.tgz"), "utf8")).toBe("local fixture archive");
    // Yeoman must retain hidden tooling, executable modes and the existing database history.
    expect((await stat(join(target, "do"))).mode & 0o111).toBe(0o111);
    expect((await stat(join(target, ".devcontainer/ensure-test-database.sh"))).mode & 0o111).toBe(0o111);
    await access(join(target, ".gitignore"));
    await expect(access(join(target, "gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(target, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    const journal = JSON.parse(await readFile(join(target, "src/server/core/db/migrations/meta/_journal.json"), "utf8"));
    expect(journal.entries.map((entry: { tag: string }) => entry.tag)).toEqual(cache === "postgres"
      ? ["0000_initial_note", "0001_postgres_cache"] : ["0000_initial_note"]);
    const app = await readFile(join(target, "src/server/core/app.ts"), "utf8");
    expect(app).toContain(cache === "redis" ? "new RedisCacheProvider(app.config.cache, app.config.redis)" : "new CacheProvider(app.config.cache)");
    const schema = await readFile(join(target, "src/server/core/db/schema/app_schema.ts"), "utf8");
    expect(schema.includes("cacheEntries")).toBe(cache === "postgres");
    const env = await readFile(join(target, ".env.example"), "utf8");
    expect(env.includes("REDIS_URL")).toBe(cache === "redis");
    expect(Object.keys(infrastructure.services)).toEqual(["app", "postgres", "drizzle-studio", ...(cache === "redis" ? ["redis"] : []), ...(insight ? ["redis-insight"] : [])]);
    expect(manifest.scripts["infra:up"]).toBe(`docker compose -f .devcontainer/docker-compose.yml up -d --build --wait postgres drizzle-studio${cache === "redis" ? " redis" : ""}${insight ? " redis-insight" : ""}`);
    // Every cache variant keeps the base database tool and its container-local credentials.
    expect(infrastructure.services["drizzle-studio"]).toMatchObject({
      build: { dockerfile: ".devcontainer/Dockerfile.drizzle-studio" },
      ports: ["127.0.0.1:4983:4983"],
      environment: { ENVIRONMENT: "local", DB_HOST: "postgres", DB_PORT: "5432" },
      depends_on: { postgres: { condition: "service_healthy" } },
    });
    await access(join(target, ".devcontainer/Dockerfile.drizzle-studio"));
    await access(join(target, "src/server/example/exampleCatalog.ts"));
    await access(join(target, "src/server/core/providers/studio_provider.ts"));
    await expect(access(join(target, "src/server/core/config/environment.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    if (cache === "redis") {
      expect(manifest.dependencies["@redis/client"]).toBeDefined();
      expect(infrastructure.services.app.environment.REDIS_URL).toBe("redis://redis:6379/0");
      expect(infrastructure.services.app.depends_on.redis.condition).toBe("service_healthy");
      expect(infrastructure.services.redis.ports).toEqual(["127.0.0.1:56379:6379"]);
    } else {
      expect(manifest.dependencies["@redis/client"]).toBeUndefined();
      expect(infrastructure.services.app.environment.REDIS_URL).toBeUndefined();
      expect(infrastructure.services.app.depends_on.redis).toBeUndefined();
    }
    if (insight) {
      expect(infrastructure.services["redis-insight"].ports).toEqual(["127.0.0.1:5540:5540"]);
      expect(infrastructure.services["redis-insight"].environment.RI_REDIS_HOST).toBe("redis");
      expect(infrastructure.volumes).toHaveProperty("redis-insight-data");
      expect(await readFile(join(target, "README.md"), "utf8")).toContain("http://127.0.0.1:5540");
    }
  });
});

it("uses PostgreSQL defaults without prompts for redirected input", async () => {
  await withFixture(async ({ target, archive }) => {
    const result = create(target, archive);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(target, "src/server/core/app.ts"), "utf8")).toContain("new CacheProvider");
  });
});

it.each([
  { options: {}, answers: { cache: "redis", redisInsight: true }, questions: ["cache", "redisInsight"] },
  { options: {}, answers: { cache: "postgres" }, questions: ["cache"] },
  { options: { cache: "redis" }, answers: { redisInsight: false }, questions: ["redisInsight"] },
  { options: { cache: "redis", redisInsight: false }, answers: {}, questions: [] },
])("asks only unresolved, applicable questions: $questions", async ({ options, answers, questions }) => {
  await withFixture(async ({ target, archive }) => {
    const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const adapter = createEnv({ stdout: output, stderr: output }).adapter;
    const prompt = vi.spyOn(adapter, "prompt").mockImplementation(async (items) => {
      const list = Array.isArray(items) ? items : [items];
      return Object.fromEntries(list.map((item) => [item.name, answers[item.name as keyof typeof answers]]));
    });
    try {
      await createApplication({ directory: target, frameworkArchive: archive, interactive: true, ...options }, adapter);
      expect(prompt.mock.calls.flatMap(([items]) => (Array.isArray(items) ? items : [items]).map((item) => item.name))).toEqual(questions);
      expect(await readdir(target)).not.toContain(".yo-rc.json");
    } finally { prompt.mockRestore(); adapter.close(); output.destroy(); }
  });
});

it.each([
  { arguments: ["--cache", "mysql"], message: "Cache must be postgres or redis" },
  { arguments: ["--cache", "postgres", "--redis-insight"], message: "Redis Insight requires Redis" },
  { arguments: ["--redis-insight", "--no-redis-insight"], message: "Choose either" },
  { arguments: ["--unknown"], message: "Unknown option" },
])("rejects invalid choices before writing: $arguments", async ({ arguments: arguments_, message }) => {
  await withFixture(async ({ target, archive }) => {
    const result = create(target, archive, ...arguments_);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("leaves no files when the user cancels a prompt", async () => {
  await withFixture(async ({ target, archive }) => {
    const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const adapter = createEnv({ stdout: output, stderr: output }).adapter;
    const prompt = vi.spyOn(adapter, "prompt").mockRejectedValue(new Error("User cancelled."));
    try {
      await expect(createApplication({ directory: target, frameworkArchive: archive, interactive: true }, adapter)).rejects.toThrow("User cancelled");
      await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { prompt.mockRestore(); adapter.close(); output.destroy(); }
  });
});

it("rejects an unavailable archive before creating the destination", async () => {
  await withFixture(async ({ target, root }) => {
    const result = create(target, join(root, "missing.tgz"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ENOENT");
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("keeps the bundled PostgreSQL migration aligned with the exported schema and contributions", async () => {
  const directory = new URL("./generators/cache/templates/postgres-migrations/", import.meta.url);
  const snapshot = JSON.parse(await readFile(new URL("meta/0001_snapshot.json", directory), "utf8"));
  const current = generateDrizzleJson({ note, utilsSchema, cacheEntries }, snapshot.id);
  expect(await generateMigration(snapshot, current)).toEqual([]);
  const custom = JSON.parse(await readFile(new URL("custom-meta/0001_postgres_cache.json", directory), "utf8"));
  expect(custom.contributions).toEqual(getDatabaseSchemaContributions({ note, utilsSchema, cacheEntries }));
  const sql = await readFile(new URL("0001_postgres_cache.sql", directory), "utf8");
  expect(sql).toContain('CREATE SCHEMA "utils"');
  expect(sql).toContain('ALTER TABLE "utils"."cache_entry" SET UNLOGGED');
});

it("preserves existing files when the target is not empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-creator-"));
  try {
    const target = join(root, "existing-app");
    const archive = join(root, "framework.tgz");
    await mkdir(target);
    await writeFile(join(target, "package.json"), "do not overwrite");
    await writeFile(archive, "local fixture archive");
    const result = spawnSync(process.execPath, [executable, target, "--framework-archive", archive], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("destination must be empty");
    expect(await readFile(join(target, "package.json"), "utf8")).toBe("do not overwrite");
  } finally {
    // The test owns this temporary directory, including failure paths.
    await rm(root, { recursive: true, force: true });
  }
});
