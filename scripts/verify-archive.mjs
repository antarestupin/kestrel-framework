import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "kestrel-consumer-"));
const application = join(temporary, "web-app");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
// Seed locked dependency versions, without allowing any workspace symlinks into the fixture.
run(process.execPath, ["src/packages/create-kestrel/bin/create.mjs", application, "--framework-archive", "artifacts/kestrel-framework-0.0.0.tgz"]);
const manifest = JSON.parse(await readFile(join(application, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
lock.name = manifest.name;
lock.version = manifest.version;
lock.packages = Object.fromEntries(Object.entries(lock.packages).filter(([path, entry]) => path.startsWith("node_modules/") && !entry.link));
lock.packages[""] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, devDependencies: manifest.devDependencies, engines: manifest.engines };
await writeFile(join(application, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...(process.env.KESTREL_VERIFY_OFFLINE === "1" ? ["--offline"] : [])], application);
for (const script of ["typecheck", "build:ai", "test:ai"]) run(npm, ["run", script], application);
run(process.execPath, ["scripts/verify-installed.mjs", application]);
console.info(`Independent consumer verified at ${application}`);
