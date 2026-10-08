import { access, mkdtemp, mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { createEnv } from "yeoman-environment";
import Generator from "yeoman-generator";
import { parse } from "yaml";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { cacheEntries } from "../kestrel/src/cache/postgres_schema.js";
import { utilsSchema } from "../kestrel/src/db/utils_schema.js";
import { getDatabaseSchemaContributions } from "../kestrel/src/db/schema_contributions/index.js";
import { note } from "./template/src/server/core/db/schema/app_schema.js";
import { createApplication } from "./generators/index.mjs";
import BaseGenerator from "./generators/base/index.mjs";
import RedisGenerator from "./generators/redis/index.mjs";

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

it("creates the named application directory from its parent", async () => {
  await withFixture(async ({ root, target }) => {
    // Run the documented command from the parent without preparing the application directory.
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    const result = spawnSync(process.execPath, [executable, "my-app", "--yes"], {
      cwd: root, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(target, "package.json"), "utf8")).name).toBe("my-app");
    await access(join(target, "src/server/core/app.ts"));
    // Application files belong to the new directory, never its parent.
    expect((await readdir(root)).sort()).toEqual(["framework.tgz", "my-app"]);
  });
});

it.each(["postgres", "redis"])("creates a registry-based %s application without an archive or installation", async (cache) => {
  await withFixture(async ({ target }) => {
    // Exercise the public CLI without the local-only override, including Docker build inputs.
    const result = spawnSync(process.execPath, [executable, target, "--cache", cache, "--yes"], {
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    const framework = JSON.parse(await readFile(new URL("../kestrel/package.json", import.meta.url), "utf8"));
    expect(manifest.dependencies[framework.name]).toBe(framework.version);
    expect(manifest.private).toBe(true);
    await expect(access(join(target, "vendor/framework.tgz"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(target, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(target, "package-lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await access(join(target, "vendor/README.md"));
    expect(await readFile(join(target, ".devcontainer/Dockerfile.drizzle-studio.dockerignore"), "utf8"))
      .toContain("!vendor/README.md");
    expect(await readFile(join(target, "do"), "utf8")).toContain(`${framework.name}/package.json`);
    expect(await readFile(join(target, "src/server/core/app.ts"), "utf8")).toContain(`${framework.name}/app`);
  });
});

it.each([
  { directory: "my-great-app", name: "my-great-app", display: "My Great App", database: "my_great_app", cache: "postgres" },
  { directory: "my_great..app--", name: "my-great-app", display: "My Great App", database: "my_great_app", cache: "redis" },
  { directory: "123", name: "123", display: "123", database: "123", cache: "postgres" },
])("uses the application identity consistently for $directory with $cache cache", async ({ directory, name, display, database, cache }) => {
  await withFixture(async ({ root, archive }) => {
    const target = join(root, directory);
    const result = create(target, archive, "--cache", cache);
    expect(result.status, result.stderr).toBe(0);
    const read = (path: string) => readFile(join(target, path), "utf8");
    const infrastructure = parse(await read(".devcontainer/docker-compose.yml"));
    const services = infrastructure.services;
    const testDatabase = `${database}_test`;
    const workspace = `/workspace/${name}`;

    // Name normalization must not redirect output to a different destination directory.
    expect(JSON.parse(await read("package.json")).name).toBe(name);
    expect(await read("src/server/core/config/database.ts")).toContain(`fallback: "${database}"`);
    expect(await read("src/server/core/config/database.ts")).toContain(`fallback: "${testDatabase}"`);
    expect(await read(".env.example")).toContain(`DB_DATABASE=${database}\nDB_TEST_DATABASE=${testDatabase}`);
    expect(services.app.environment).toMatchObject({ DB_DATABASE: database, DB_TEST_DATABASE: testDatabase });
    expect(services.postgres.environment.POSTGRES_DB).toBe(database);
    expect(services.postgres.healthcheck.test).toEqual(["CMD-SHELL", `pg_isready -U postgres -d ${database}`]);
    expect(services["drizzle-studio"].environment.DB_DATABASE).toBe(database);
    expect(await read(".devcontainer/ensure-test-database.sh")).toContain(`DB_TEST_DATABASE:-${testDatabase}`);

    // Every path participating in the container workspace must agree, including tooling mounts.
    expect(await read(".devcontainer/devcontainer.json")).toContain(`"name": "${display}"`);
    expect(await read(".devcontainer/devcontainer.json")).toContain(`"workspaceFolder": "${workspace}"`);
    expect(services.app.working_dir).toBe(workspace);
    expect(services.app.volumes).toEqual([`..:${workspace}:cached`, `node-modules:${workspace}/node_modules`]);
    expect(services.app.command).toBe(`/bin/sh -c "mkdir -p ${workspace}/node_modules && chown -R node:node ${workspace}/node_modules && sleep infinity"`);
    expect(services["drizzle-studio"].working_dir).toBe(workspace);
    expect(services["drizzle-studio"].volumes).toEqual([
      `../src:${workspace}/src:ro`,
      `../drizzle.database.ts:${workspace}/drizzle.database.ts:ro`,
      `../drizzle.dev.config.ts:${workspace}/drizzle.dev.config.ts:ro`,
    ]);
    expect(await read(".devcontainer/Dockerfile")).toContain(`mkdir -p ${workspace}`);
    expect(await read(".devcontainer/Dockerfile.drizzle-studio")).toContain(`WORKDIR ${workspace}`);

    const readme = await read("README.md");
    expect(readme).toContain(`# ${display}\n`);
    expect(readme).toContain(`database \`${database}\`; tests use \`${testDatabase}\``);
    expect(readme).not.toContain("repository playground");
    const html = await read("src/client/index.html");
    expect(html).toContain(`<title>${display}</title>`);
    expect(html).toContain(`content="Welcome to ${display}."`);
    const client = await read("src/client/src/main.tsx");
    expect(client).toContain(`aria-label="${display}"`);
    expect(client).toContain(`>${display}</span>`);
    expect(client).toContain(`>${display[0]}.</span>`);
    expect(client).toContain(`${display} is running`);
    expect(client).toContain(`Welcome to ${display}.`);
    expect(client).toContain("Kestrel Studio");
    expect(client).toContain("https://antarestupin.github.io/kestrel-framework/");
    expect(await read("src/server/core/db/seed.ts")).toContain(`content: "Welcome to ${display}."`);
    expect(await read("src/server/core/config/cache.ts")).toContain(`namespace: "${name}"`);
    if (cache === "redis") expect(services["redis-insight"].environment.RI_REDIS_ALIAS).toBe(display);

    // Detect forgotten placeholders and old defaults throughout the generated tree, including dotfiles.
    for (const file of await readdir(target, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || file.name.endsWith(".tgz")) continue;
      const content = await readFile(join(file.parentPath, file.name), "utf8");
      expect(content, file.name).not.toMatch(/__KESTREL_|kestrel_playground|\/workspace\/app\b/);
    }
  });
});

it("uses the same bounded database names in generated configuration and infrastructure", async () => {
  await withFixture(async ({ root, archive }) => {
    const target = join(root, "a".repeat(59));
    expect(create(target, archive).status).toBe(0);
    const infrastructure = parse(await readFile(join(target, ".devcontainer/docker-compose.yml"), "utf8"));
    const { DB_DATABASE: database, DB_TEST_DATABASE: testDatabase } = infrastructure.services.app.environment;
    expect(database).toMatch(/^a{49}_[a-f0-9]{8}$/);
    expect(testDatabase).toBe(`${database}_test`);
    expect(testDatabase).toHaveLength(63);
    const config = await readFile(join(target, "src/server/core/config/database.ts"), "utf8");
    expect(config).toContain(`fallback: "${database}"`);
    expect(config).toContain(`fallback: "${testDatabase}"`);
  });
});

it.each(["UpperCase", "invalid name", "invalid'name", "a".repeat(215)])("rejects unsafe or oversized application names before writing: %s", async (name) => {
  await withFixture(async ({ root, archive }) => {
    const target = join(root, name);
    const result = create(target, archive);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lowercase npm-compatible directory name");
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it.each(["postgres", "redis"])("composes %s cache with its required infrastructure", async (cache) => {
  await withFixture(async ({ target, archive }) => {
    const result = create(target, archive, "--cache", cache);
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    const infrastructure = parse(await readFile(join(target, ".devcontainer/docker-compose.yml"), "utf8"));
    expect(manifest.name).toBe("my-app");
    expect(manifest.dependencies["@kestreljs/framework"]).toBe("file:vendor/framework.tgz");
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
    expect(app).toContain("new CacheProvider(app.config.cache, ");
    expect(app).toContain(cache === "redis" ? "redisCache(redisDependency, app.config.cache.adapter)" : "postgresCache(databaseDependency, app.config.cache.adapter)");
    const cacheConfig = await readFile(join(target, "src/server/core/config/cache.ts"), "utf8");
    expect(cacheConfig).toContain(`adapter: configure(${cache}CacheConfigBase, {})`);
    await expect(access(join(target, "src/server/core/providers/redis_cache_provider.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    const schema = await readFile(join(target, "src/server/core/db/schema/app_schema.ts"), "utf8");
    expect(schema.includes("cacheEntries")).toBe(cache === "postgres");
    const env = await readFile(join(target, ".env.example"), "utf8");
    expect(env.includes("REDIS_URL")).toBe(cache === "redis");
    expect(Object.keys(infrastructure.services)).toEqual(["app", "postgres", "drizzle-studio", ...(cache === "redis" ? ["redis", "redis-insight"] : [])]);
    expect(manifest.scripts["infra:up"]).toBe(`docker compose -f .devcontainer/docker-compose.yml up -d --build --wait postgres drizzle-studio${cache === "redis" ? " redis redis-insight" : ""}`);
    // Every cache variant keeps the base database tool and its container-local credentials.
    expect(infrastructure.services["drizzle-studio"]).toMatchObject({
      build: { dockerfile: ".devcontainer/Dockerfile.drizzle-studio" },
      ports: ["127.0.0.1:4983:4983"],
      environment: { ENVIRONMENT: "local", DB_HOST: "postgres", DB_PORT: "5432" },
      depends_on: { postgres: { condition: "service_healthy" } },
    });
    await access(join(target, ".devcontainer/Dockerfile.drizzle-studio"));
    await access(join(target, "src/server/example/example_catalog.ts"));
    await access(join(target, "src/server/core/providers/studio_provider.ts"));
    await expect(access(join(target, "src/server/core/config/environment.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    if (cache === "redis") {
      expect(manifest.dependencies["@redis/client"]).toBeDefined();
      expect(infrastructure.services.redis.command).toEqual(expect.arrayContaining(["--maxmemory-policy", "noeviction"]));
      expect(app.match(/new RedisProvider\(/g)).toHaveLength(1);
      // All providers register before cache storage is resolved at boot.
      expect(app).toContain("redisCache(redisDependency, app.config.cache.adapter)");
      await access(join(target, "src/server/core/cache.test.ts"));
      await access(join(target, "src/server/core/providers/redis_provider.test.ts"));
      expect(infrastructure.services.app.environment.REDIS_URL).toBe("redis://redis:6379/0");
      expect(infrastructure.services.app.depends_on.redis.condition).toBe("service_healthy");
      expect(infrastructure.services.redis.ports).toEqual(["127.0.0.1:56379:6379"]);
    } else {
      expect(manifest.dependencies["@redis/client"]).toBeUndefined();
      expect(infrastructure.services.app.environment.REDIS_URL).toBeUndefined();
      expect(infrastructure.services.app.depends_on.redis).toBeUndefined();
    }
    if (cache === "redis") {
      expect(infrastructure.services["redis-insight"].ports).toEqual(["127.0.0.1:5540:5540"]);
      expect(infrastructure.services["redis-insight"].environment.RI_REDIS_HOST).toBe("redis");
      expect(infrastructure.volumes).toHaveProperty("redis-insight-data");
      expect(await readFile(join(target, "README.md"), "utf8")).toContain("http://127.0.0.1:5540");
    }
  });
});

it.each([
  { cache: "postgres", atlas: true }, { cache: "postgres", atlas: false },
  { cache: "redis", atlas: true }, { cache: "redis", atlas: false },
])("composes the explicit Atlas choice with $cache cache: $atlas", async ({ cache, atlas }) => {
  await withFixture(async ({ target, archive }) => {
    const result = create(target, archive, "--cache", cache, atlas ? "--atlas" : "--no-atlas", "--yes");
    expect(result.status, result.stderr).toBe(0);
    const read = (path: string) => readFile(join(target, path), "utf8");
    const app = await read("src/server/core/app.ts");
    expect(app.includes("new ApplicationAtlasProvider")).toBe(atlas);
    // Administration definitions live beside the server and browser, not inside the server tree.
    await expect(access(join(target, "src/server/atlas"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await read("src/server/core/app_config.ts")).includes("createBackofficeConfig")).toBe(atlas);
    expect((await read("src/client/src/main.tsx")).includes('href="/admin"')).toBe(atlas);
    const manifest = JSON.parse(await read("package.json"));
    expect(Object.keys(manifest.dependencies).some((name) => name.includes("atlas"))).toBe(false);
    if (atlas) {
      expect(await read("src/admin/index.ts")).toContain("resources: []");
      expect(await read("src/admin/index.ts")).toContain('basePath: "/admin"');
      const provider = await read("src/server/core/providers/atlas_provider.ts");
      expect(provider).toContain('import { applicationBackoffice } from "../../../admin/index.js"');
      expect(provider).toContain('AppConfig["backoffice"]');
      expect(app).toContain("new ApplicationAtlasProvider(app.config.backoffice)");
      expect(await read("src/server/core/config/backoffice.ts")).toContain("local: true");
      expect(app).toContain('...(app.config.backoffice.enabled ? [] : [applicationBackoffice.basePath, "/_atlas_assets"])');
      expect(app.indexOf("new ApplicationAtlasProvider")).toBeLessThan(app.indexOf("new StudioProvider"));
      expect(await read("README.md")).toContain("## Atlas");
      await access(join(target, "src/admin/index.test.ts"));
    } else {
      await expect(access(join(target, "src/admin"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(target, "src/server/core/providers/atlas_provider.ts"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(target, "src/server/core/config/backoffice.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

it.each([[], ["--yes"]])("uses PostgreSQL and Atlas defaults without prompts: %j", async (...arguments_: string[]) => {
  await withFixture(async ({ target, archive }) => {
    const result = create(target, archive, ...arguments_);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(target, "src/server/core/app.ts"), "utf8")).toContain("new CacheProvider");
    await access(join(target, "src/admin/index.ts"));
    expect(await readFile(join(target, "src/server/core/app.ts"), "utf8")).toContain("new ApplicationAtlasProvider");
  });
});

it("composes shared Redis infrastructure without a cache feature", async () => {
  await withFixture(async ({ target }) => {
    // A future non-cache feature can request the same standalone Redis generator.
    class RedisOnlyApplication extends Generator {
      async configuring() {
        const options = { destination: target, applicationName: "my-app" };
        await this.composeWith("fixture:base", options);
        await this.composeWith("fixture:redis", options);
      }
    }
    const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const environment = createEnv({ stdout: output, stderr: output, sharedOptions: { skipCache: true, localConfigOnly: true } });
    environment.registerStub(RedisOnlyApplication, "fixture:application");
    environment.registerStub(BaseGenerator, "fixture:base");
    environment.registerStub(RedisGenerator, "fixture:redis");
    try {
      await environment.run("fixture:application", { skipInstall: true });
      const app = await readFile(join(target, "src/server/core/app.ts"), "utf8");
      expect(app).toContain("new RedisProvider(app.config.redis)");
      expect(app).not.toContain("CacheProvider");
      const infrastructure = parse(await readFile(join(target, ".devcontainer/docker-compose.yml"), "utf8"));
      expect(infrastructure.services).toHaveProperty("redis-insight");
      await expect(access(join(target, "src/server/core/config/cache.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { environment.adapter.close(); output.destroy(); }
  });
});

it.each([
  { options: {}, answers: { cache: "redis", atlas: true }, questions: ["cache", "atlas"] },
  { options: {}, answers: { cache: "postgres", atlas: false }, questions: ["cache", "atlas"] },
  { options: { cache: "redis" }, answers: { atlas: true }, questions: ["atlas"] },
  { options: { atlas: false }, answers: { cache: "postgres" }, questions: ["cache"] },
  { options: { cache: "redis", atlas: false }, answers: {}, questions: [] },
  { options: { cache: "postgres", atlas: true }, answers: {}, questions: [] },
  { options: { cache: "postgres" }, answers: {}, questions: ["atlas"] },
])("asks only unresolved, applicable questions: $questions", async ({ options, answers, questions }) => {
  await withFixture(async ({ target, archive }) => {
    const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const adapter = createEnv({ stdout: output, stderr: output }).adapter;
    const prompt = vi.spyOn(adapter, "prompt").mockImplementation(async (items) => {
      const list = Array.isArray(items) ? items : [items];
      // An unanswered confirmation accepts the displayed default, as pressing Enter would.
      return Object.fromEntries(list.map((item) => [item.name, answers[item.name as keyof typeof answers] ?? item.default]));
    });
    try {
      await createApplication({ directory: target, frameworkArchive: archive, interactive: true, ...options }, adapter);
      expect(prompt.mock.calls.flatMap(([items]) => (Array.isArray(items) ? items : [items]).map((item) => item.name))).toEqual(questions);
      for (const [items] of prompt.mock.calls) {
        const atlasQuestion = (Array.isArray(items) ? items : [items]).find((item) => item.name === "atlas");
        if (atlasQuestion) expect(atlasQuestion.default).toBe(true);
      }
      expect(await readdir(target)).not.toContain(".yo-rc.json");
      expect(await readFile(join(target, "src/server/core/app.ts"), "utf8")).toContain(
        (options.atlas ?? answers.atlas ?? true) ? "new ApplicationAtlasProvider" : "new StudioProvider",
      );
      if (!(options.atlas ?? answers.atlas ?? true)) {
        await expect(access(join(target, "src/admin"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { prompt.mockRestore(); adapter.close(); output.destroy(); }
  });
});

it.each([
  { arguments: ["--cache", "mysql"], message: "Cache must be postgres or redis" },
  { arguments: ["--atlas", "--no-atlas"], message: "Choose either --atlas or --no-atlas" },
  { arguments: ["--redis-insight"], message: "Unknown option" },
  { arguments: ["--no-redis-insight"], message: "Unknown option" },
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
