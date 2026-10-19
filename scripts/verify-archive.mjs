import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { audit } from "./release/security.mjs";
import { run as execute } from "./release/common.mjs";
import { consumerVariants, verificationSelections } from "./release/evidence.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const archives = resolve(process.argv[2] ?? join(root, "artifacts"));
const reports = resolve(process.argv[3] ?? join(archives, "verification"));
// Each worker owns its temporary installations and report directory.
const selection = process.argv[4] ?? "all";
if (selection !== "all" && !verificationSelections.includes(selection)) throw new Error(`Unknown consumer: ${selection}`);
const temporary = await mkdtemp(join(tmpdir(), "kestrel-consumer-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// Derive archive filenames from release metadata so version bumps do not break verification.
const creatorManifest = JSON.parse(await readFile(new URL("../src/packages/create-kestrel/package.json", import.meta.url), "utf8"));
const frameworkManifest = JSON.parse(await readFile(new URL("../src/packages/kestrel/package.json", import.meta.url), "utf8"));
const archiveName = ({ name, version }) => `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
let step = 0;
async function run(command, args, cwd = root) {
  // Keep npm on the selected runtime and retain timings for each installation/build/check.
  const useCurrentNpm = command === npm && process.env.npm_execpath;
  const log = join(reports, "steps", `${String(++step).padStart(2, "0")}-${basename(cwd)}-${basename(command)}.log`);
  await execute(useCurrentNpm ? process.execPath : command, useCurrentNpm ? [process.env.npm_execpath, ...args] : args, { cwd, log });
}

/** Each consumer resolves its own complete lock instead of inheriting workspace metadata. */
async function install(directory, { scope = "consumer", production = false } = {}) {
  // Resolve and audit without executing lifecycle scripts before installing any consumer code.
  await run(npm, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], directory);
  await audit(directory, scope, join(reports, directory.split("/").at(-1)), { production });
  await run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", ...(production ? ["--omit=dev"] : [])], directory);
}

try {
  // Exercise the shipped create-kestrel executable, including its bundled generators and dotfiles.
  // Both archives are supplied by the candidate; verification must never repack them.
  const creator = join(temporary, "creator");
  await mkdir(creator);
  await writeFile(join(creator, "package.json"), JSON.stringify({
    name: "kestrel-creator-fixture", version: "0.0.0", private: true,
    dependencies: { [creatorManifest.name]: `file:${join(archives, archiveName(creatorManifest))}` },
  }, null, 2) + "\n");
  await install(creator, { scope: "creator", production: true });
  if (selection === "all" || selection === "package") {
    const framework = join(temporary, "framework");
    await mkdir(framework);
    await writeFile(join(framework, "package.json"), JSON.stringify({ name: "framework-production-fixture", version: "0.0.0", private: true, dependencies: { [frameworkManifest.name]: `file:${join(archives, archiveName(frameworkManifest))}` } }));
    await install(framework, { scope: "framework", production: true });
    await run(process.execPath, ["scripts/verify-installed.mjs", framework, "--package-only"]);
    // Verify the installed creator's default registry contract before testing local-archive consumers.
    const registryApplication = join(temporary, "registry-app");
    await run(process.execPath, [join(creator, "node_modules/.bin/create-kestrel"), registryApplication, "--yes"]);
    const generated = JSON.parse(await readFile(join(registryApplication, "package.json"), "utf8"));
    if (generated.dependencies[frameworkManifest.name] !== frameworkManifest.version) {
      throw new Error("The generated registry dependency must match the framework release.");
    }
  }
  for (const [name, cache, atlas] of consumerVariants.filter(([name]) => selection === "all" || selection === name)) {
    const application = join(temporary, name);
    await run(process.execPath, [join(creator, "node_modules/.bin/create-kestrel"), application,
      "--framework-archive", join(archives, archiveName(frameworkManifest)), "--cache", cache,
      atlas ? "--atlas" : "--no-atlas", "--yes"]);
    await install(application);
    for (const script of ["typecheck", "build:ai", "test:ai", "db:check"]) await run(npm, ["run", script], application);
    await run(process.execPath, ["scripts/verify-installed.mjs", application]);
    // A deployment contains only compiled output and its locked production dependencies.
    const deployment = join(temporary, `${name}-production`);
    await mkdir(deployment);
    for (const file of ["package.json", "package-lock.json", "dist", "vendor"]) {
      await cp(join(application, file), join(deployment, file), { recursive: true });
    }
    const deploymentManifest = JSON.parse(await readFile(join(deployment, "package.json"), "utf8"));
    deploymentManifest.kestrelReleaseAtlas = atlas;
    await writeFile(join(deployment, "package.json"), JSON.stringify(deploymentManifest, null, 2) + "\n");
    await run(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], deployment);
    await run(process.execPath, ["scripts/verify-production.mjs", deployment]);
    console.info(`Independent ${cache} consumer ${atlas ? "with" : "without"} Atlas verified.`);
  }
} finally {
  // Fixture installs and compiled outputs are owned by this verification run.
  await rm(temporary, { recursive: true, force: true });
}
