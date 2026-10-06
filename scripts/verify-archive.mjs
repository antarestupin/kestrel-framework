import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "kestrel-consumer-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// Derive archive filenames from release metadata so version bumps do not break verification.
const creatorManifest = JSON.parse(await readFile(new URL("../src/packages/create-kestrel/package.json", import.meta.url), "utf8"));
const frameworkManifest = JSON.parse(await readFile(new URL("../src/packages/kestrel/package.json", import.meta.url), "utf8"));
const archiveName = ({ name, version }) => `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
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
  run(npm, ["pack", "--workspace=@kestreljs/create-kestrel", "--pack-destination", temporary, "--ignore-scripts", "--silent"]);
  const creator = join(temporary, "creator");
  await mkdir(creator);
  await writeFile(join(creator, "package.json"), JSON.stringify({
    name: "kestrel-creator-fixture", version: "0.0.0", private: true,
    dependencies: { [creatorManifest.name]: `file:${join(temporary, archiveName(creatorManifest))}` },
  }, null, 2) + "\n");
  await install(creator);
  // Verify the installed creator's default registry contract before testing local-archive consumers.
  const registryApplication = join(temporary, "registry-app");
  run(process.execPath, [join(creator, "node_modules/.bin/create-kestrel"), registryApplication, "--yes"]);
  const generated = JSON.parse(await readFile(join(registryApplication, "package.json"), "utf8"));
  if (generated.dependencies[frameworkManifest.name] !== frameworkManifest.version) {
    throw new Error("The generated registry dependency must match the framework release.");
  }
  for (const [name, cache] of [
    ["postgres-app", "postgres"],
    ["redis-app", "redis"],
  ]) {
    const application = join(temporary, name);
    run(process.execPath, [join(creator, "node_modules/.bin/create-kestrel"), application,
      "--framework-archive", join(root, "artifacts", archiveName(frameworkManifest)), "--cache", cache, "--yes"]);
    await install(application);
    for (const script of ["typecheck", "build:ai", "test:ai", "db:check"]) run(npm, ["run", script], application);
    run(process.execPath, ["scripts/verify-installed.mjs", application]);
    console.info(`Independent ${cache} consumer verified.`);
  }
} finally {
  // Fixture installs and compiled outputs are owned by this verification run.
  await rm(temporary, { recursive: true, force: true });
}
