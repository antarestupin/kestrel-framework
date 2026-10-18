import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import { audit } from "./release/security.mjs";
import { checkCandidate, createCandidateDirectory, pack, reportInventory, sourceIdentity, verifyHashes } from "./release/candidate.mjs";
import { npm, readJson, root, run, writeJson } from "./release/common.mjs";

const [command, path, selection = "all"] = process.argv.slice(2);
let directory = resolve(path ?? "artifacts/candidate");
if (["validate", "verify"].includes(command)) {
  const version = (await npm(["--version"], { capture: true })).stdout.trim();
  assert.equal(version, "11.9.0", "Release validation requires npm 11.9.0 at every Node checkpoint");
}

// Preserve the first-run CI path while allowing repeated local validation without cleanup.
if (command === "validate") {
  directory = await createCandidateDirectory(directory, { unique: path === undefined });
  console.info(`Validating release candidate at ${directory}`);
  console.info(`Additional runtime verification: npm run release:verify -- "${directory}"`);
}
const manifestPath = resolve(directory, "candidate.json");

if (command === "pack") {
  await pack(directory);
} else if (command === "validate") {
  const source = await sourceIdentity();
  const manifest = { format: 1, status: "validating", source, createdAt: new Date().toISOString(), node: process.version,
    npm: (await npm(["--version"], { capture: true })).stdout.trim(), archives: [], verifications: [] };
  await writeJson(manifestPath, manifest);
  try {
    await cp(resolve(root, "scripts/release/security-policy.json"), resolve(directory, "reports/security-policy.json"));
    await audit(root, "workspace", resolve(directory, "reports/workspace"));
    for (const script of ["check:boundaries", "check:playground", "test:release", "build:ai", "typecheck", "test:ai", "test:generator", "docs:build"]) {
      await npm(["run", script], { log: resolve(directory, `reports/${script.replaceAll(":", "-")}.log`) });
    }
    assert.deepEqual(await sourceIdentity(), source, "Validation changed source inputs");
    manifest.archives = await pack(directory);
    await writeJson(manifestPath, manifest);
    await verify(manifest);
  } catch (error) {
    manifest.status = "failed";
    manifest.failure = error.message;
    await writeJson(manifestPath, manifest);
    throw error;
  }
} else if (command === "verify") {
  const manifest = await checkCandidate(directory);
  assert.equal(manifest.status, "validated", "Only a completed candidate can receive additional runtime verification");
  assert.deepEqual(await sourceIdentity(), manifest.source, "Verification requires the candidate source inputs");
  manifest.status = "verifying";
  await writeJson(manifestPath, manifest);
  try { await verify(manifest); }
  catch (error) { manifest.status = "failed"; manifest.failure = error.message; await writeJson(manifestPath, manifest); throw error; }
} else if (command === "publish") {
  // This is the only registry-writing branch. Calling validate/verify never authorizes it.
  const manifest = await checkCandidate(directory, { publish: true });
  assert(["all", "framework", "creator"].includes(selection), "Choose all, framework, or creator");
  for (const archive of manifest.archives.filter((item) => selection === "all" || item.name === (selection === "framework" ? "@kestreljs/framework" : "@kestreljs/create-kestrel"))) {
    await npm(["publish", resolve(directory, archive.file), "--ignore-scripts", "--access", "public", "--tag", "next"]);
  }
} else {
  throw new Error("Usage: node scripts/release.mjs <pack|validate|verify|publish> [candidate-directory] [all|framework|creator]");
}

/** Additional Node versions inspect the very same tarballs, without building them again. */
async function verify(manifest) {
  assert.match(process.version, /^v24\./u, "Only Node 24 is supported");
  const reports = resolve(directory, "reports", process.version);
  await run(process.execPath, ["scripts/verify-archive.mjs", directory, reports], { log: resolve(reports, "verification.log"), env: { ...process.env, npm_config_engine_strict: "true" } });
  await verifyHashes(directory, manifest.archives);
  assert.deepEqual(await sourceIdentity(), manifest.source, "Verification changed source inputs");
  manifest.verifications.push({ node: process.version, npm: (await npm(["--version"], { capture: true })).stdout.trim(), completedAt: new Date().toISOString() });
  manifest.status = "validated";
  manifest.validatedAt = new Date().toISOString();
  manifest.reports = await reportInventory(directory);
  await writeJson(manifestPath, manifest);
  console.info(`Validated candidate retained at ${directory}. No npm publication performed.`);
}
