import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "kestrel-consumer-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

/** Seed locked versions without workspace links for both the creator and its consumers. */
async function install(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  lock.name = manifest.name;
  lock.version = manifest.version;
  lock.packages = Object.fromEntries(Object.entries(lock.packages).filter(([path, entry]) => path.startsWith("node_modules/") && !entry.link));
  lock.packages[""] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, devDependencies: manifest.devDependencies, engines: manifest.engines };
  await writeFile(join(directory, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...(process.env.KESTREL_VERIFY_OFFLINE === "1" ? ["--offline"] : [])], directory);
}

try {
  // Exercise the shipped create-kestrel executable, including its bundled generators and dotfiles.
  run(npm, ["pack", "--workspace=@kestrel/create-app", "--pack-destination", temporary, "--ignore-scripts", "--silent"]);
  const creator = join(temporary, "creator");
  await mkdir(creator);
  await writeFile(join(creator, "package.json"), JSON.stringify({
    name: "kestrel-creator-fixture", version: "0.0.0", private: true,
    dependencies: { "@kestrel/create-app": `file:${join(temporary, "kestrel-create-app-0.0.0.tgz")}` },
  }, null, 2) + "\n");
  await install(creator);
  for (const [name, cache, insight] of [
    ["postgres-app", "postgres", false],
    ["redis-app", "redis", false],
    ["redis-insight-app", "redis", true],
  ]) {
    const application = join(temporary, name);
    run(process.execPath, [join(creator, "node_modules/.bin/create-kestrel"), application,
      "--framework-archive", "artifacts/kestrel-framework-0.0.0.tgz", "--cache", cache,
      insight ? "--redis-insight" : "--no-redis-insight"]);
    await install(application);
    for (const script of ["typecheck", "build:ai", "test:ai", "db:check"]) run(npm, ["run", script], application);
    run(process.execPath, ["scripts/verify-installed.mjs", application]);
    console.info(`Independent ${cache} consumer verified (Redis Insight: ${insight}).`);
  }
} finally {
  // Fixture installs and compiled outputs are owned by this verification run.
  await rm(temporary, { recursive: true, force: true });
}
