import assert from "node:assert/strict";
import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { audit } from "./release/security.mjs";
import { checkCandidate, createCandidateDirectory, pack, reportInventory, sourceIdentity, verifyHashes } from "./release/candidate.mjs";
import { assertSupportedNode, checkEvidence, validationNpm, verificationSelections } from "./release/evidence.mjs";
import { npm, root, run, runConcurrent, writeJson } from "./release/common.mjs";

const [command, path, selection = "all"] = process.argv.slice(2);
let directory = resolve(path ?? (command === "docs" ? "artifacts/documentation" : "artifacts/candidate"));
// CI pins the minimum runtime; local commands accept the supported package engine range.
if (["validate", "prepare", "consumer", "docs", "finalize", "verify"].includes(command)) {
  assertSupportedNode(process.version);
  assert.equal((await npm(["--version"], { capture: true })).stdout.trim(), validationNpm, "Release validation requires npm 11.9.0");
}

if (["validate", "prepare"].includes(command)) {
  directory = await createCandidateDirectory(directory, { unique: path === undefined });
  console.info(`Preparing release candidate at ${directory}`);
}
const manifestPath = resolve(directory, "candidate.json");

if (command === "pack") {
  await pack(directory);
} else if (["validate", "prepare"].includes(command)) {
  const source = await sourceIdentity();
  const manifest = { format: 1, status: "validating", source, createdAt: new Date().toISOString(), node: process.version,
    npm: validationNpm, archives: [], verifications: [] };
  await writeJson(manifestPath, manifest);
  try {
    await cp(resolve(root, "scripts/release/security-policy.json"), resolve(directory, "reports/security-policy.json"));
    await audit(root, "workspace", resolve(directory, "reports/workspace"));
    for (const script of ["check:boundaries", "check:playground", "test:release", "build:ai"]) {
      await npm(["run", script], { log: resolve(directory, `reports/${script.replaceAll(":", "-")}.log`) });
    }
    // Generated contracts and framework output must exist before these independent checks start.
    await runConcurrent(["typecheck", "test:ai", "test:generator"].map((script) => () =>
      npm(["run", script], { log: resolve(directory, `reports/${script.replaceAll(":", "-")}.log`) })));
    if (command === "validate") await documentation(directory);
    assert.deepEqual(await sourceIdentity(), source, "Validation changed source inputs");
    manifest.archives = await pack(directory);
    manifest.status = "prepared";
    await writeJson(manifestPath, manifest);
    if (command === "validate") {
      await consumers();
      await finalize(manifest);
    }
  } catch (error) {
    manifest.status = "failed";
    manifest.failure = error.message;
    await writeJson(manifestPath, manifest);
    throw error;
  }
} else if (command === "docs") {
  await documentation(directory);
} else if (command === "consumer") {
  assert(verificationSelections.includes(selection), "Choose a known consumer selection");
  const manifest = await checkCandidate(directory);
  assert.equal(manifest.status, "prepared", "Consumers require a prepared candidate");
  assert.deepEqual(await sourceIdentity(), manifest.source, "Verification requires the candidate source inputs");
  const reports = resolve(directory, "reports/consumers", selection);
  // Remove a previous success before retrying, so a failed retry cannot reuse its receipt.
  await rm(resolve(reports, "result.json"), { force: true });
  await run(process.execPath, ["scripts/verify-archive.mjs", directory, reports, selection], {
    log: resolve(reports, "verification.log"), env: { ...process.env, npm_config_engine_strict: "true" },
  });
  await verifyHashes(directory, manifest.archives);
  assert.deepEqual(await sourceIdentity(), manifest.source, "Verification changed source inputs");
  await writeJson(resolve(reports, "result.json"), { ...receipt(manifest.source), selection, archives: manifest.archives });
} else if (["finalize", "verify"].includes(command)) {
  const manifest = await checkCandidate(directory);
  assert(["prepared", "validated"].includes(manifest.status), "Verification requires a prepared or validated candidate");
  assert.deepEqual(await sourceIdentity(), manifest.source, "Verification requires the candidate source inputs");
  if (command === "verify") {
    // Invalidate the old seal before rerunning workers against the same archives.
    manifest.status = "prepared";
    await writeJson(manifestPath, manifest);
    await consumers();
  }
  await finalize(manifest);
} else if (command === "publish") {
  // This is the only registry-writing branch. Validation never authorizes publication.
  const manifest = await checkCandidate(directory, { publish: true });
  assert(["all", "framework", "creator"].includes(selection), "Choose all, framework, or creator");
  for (const archive of manifest.archives.filter((item) => selection === "all" || item.name === (selection === "framework" ? "@kestreljs/framework" : "@kestreljs/create-kestrel"))) {
    await npm(["publish", resolve(directory, archive.file), "--ignore-scripts", "--access", "public", "--tag", "next"]);
  }
} else {
  throw new Error("Usage: node scripts/release.mjs <pack|validate|prepare|docs|consumer|finalize|verify|publish> [candidate-directory] [selection]");
}

function receipt(source) {
  return { status: "passed", source, node: process.version, npm: validationNpm, completedAt: new Date().toISOString() };
}

/** The reusable CI documentation job and local validation retain identical evidence. */
async function documentation(target) {
  const source = await sourceIdentity();
  const reports = resolve(target, "reports/docs");
  await rm(resolve(reports, "result.json"), { force: true });
  await npm(["run", "docs:build"], { log: resolve(reports, "build.log") });
  assert.deepEqual(await sourceIdentity(), source, "Documentation build changed source inputs");
  await writeJson(resolve(reports, "result.json"), receipt(source));
}

/** Wait for every owned worker before returning, including when one consumer fails. */
async function consumers() {
  // CI isolates each matrix selection; local validation limits concurrent builds and installs.
  await runConcurrent(verificationSelections.map((name) => () =>
    run(process.execPath, ["scripts/release.mjs", "consumer", directory, name])));
}

/** Only the aggregator writes the final manifest after all independent jobs succeed. */
async function finalize(manifest) {
  await verifyHashes(directory, manifest.archives);
  const runtime = await checkEvidence(directory, manifest);
  assert.deepEqual(await sourceIdentity(), manifest.source, "Verification changed source inputs");
  // Record the workers' actual runtime rather than claiming the CI minimum was used.
  manifest.verifications = [{ ...runtime, completedAt: new Date().toISOString() }];
  manifest.status = "validated";
  manifest.validatedAt = new Date().toISOString();
  manifest.reports = await reportInventory(directory);
  await writeJson(manifestPath, manifest);
  console.info(`Validated candidate retained at ${directory}. No npm publication performed.`);
}
