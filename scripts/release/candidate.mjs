import assert from "node:assert/strict";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { checkEvidence, validationNode } from "./evidence.mjs";
import { candidateFile, digest, npm, readJson, root, run, writeJson } from "./common.mjs";

export const packages = ["kestrel", "create-kestrel"];

/** Claim a fresh directory atomically, optionally skipping paths retained by earlier runs. */
export async function createCandidateDirectory(directory, { unique = false } = {}) {
  await mkdir(dirname(directory), { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? directory : `${directory}-${attempt}`;
    try {
      await mkdir(candidate);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Only automatic selection may change the requested path; explicit paths stay strict.
      if (unique) continue;
      throw new Error(`Release candidate path already exists: ${directory}. Existing validation evidence was preserved. Run npm run release:validate without a path to select a fresh directory automatically.`, { cause: error });
    }
    await mkdir(resolve(candidate, "reports"));
    return candidate;
  }
}

/** Capture tracked and untracked non-ignored inputs so edits cannot reuse earlier validation. */
export async function sourceIdentity() {
  const { stdout } = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { capture: true });
  const hash = createHash("sha256");
  for (const file of [...new Set(stdout.split("\0").filter(Boolean))].sort()) {
    hash.update(file + "\0");
    try { hash.update(await readFile(resolve(root, file))); }
    catch (error) { if (error.code !== "ENOENT") throw error; hash.update("<deleted>"); }
  }
  const commit = (await run("git", ["rev-parse", "HEAD"], { capture: true })).stdout.trim();
  const dirty = Boolean((await run("git", ["status", "--porcelain"], { capture: true })).stdout.trim());
  return { commit, dirty, sha256: hash.digest("hex") };
}

/** Archive metadata is captured immediately after packing, before any consumers execute it. */
export async function pack(directory) {
  const framework = await readJson(resolve(root, "src/packages/kestrel/package.json"));
  const creator = await readJson(resolve(root, "src/packages/create-kestrel/package.json"));
  assert.equal(creator.version, framework.version, "Framework and creator release versions must match");
  for (const path of ["package.json", "src/packages/kestrel/package.json", "src/packages/create-kestrel/package.json", "src/packages/create-kestrel/template/package.json", "src/apps/playground/package.json"]) {
    const manifest = await readJson(resolve(root, path));
    assert.equal(manifest.engines.node, ">=24.11.0 <25", `${path}: supported Node range`);
    if (path.includes("template") || path.includes("playground")) assert.equal(manifest.dependencies[framework.name], framework.version, `${path}: framework version`);
  }
  await mkdir(directory, { recursive: true });
  const archives = [];
  for (const name of packages) {
    const { stdout } = await npm(["pack", `--workspace=./src/packages/${name}`, "--ignore-scripts", "--json", `--pack-destination=${directory}`], {
      capture: true, log: resolve(directory, `reports/pack-${name}.log`),
    });
    const [item] = JSON.parse(stdout);
    archives.push({ name: item.name, version: item.version, file: item.filename, sha256: await digest(candidateFile(directory, item.filename)) });
  }
  return archives;
}

export async function verifyHashes(directory, entries) {
  assert(entries?.length, "Missing artifact evidence");
  for (const item of entries) assert.equal(await digest(candidateFile(directory, item.file)), item.sha256, `Changed artifact: ${item.file}`);
}

/** Seal every retained report; publication detects modifications or missing files. */
export async function reportInventory(directory) {
  const files = await readdir(resolve(directory, "reports"), { recursive: true, withFileTypes: true });
  const output = [];
  for (const file of files.filter((entry) => entry.isFile())) {
    const path = resolve(file.parentPath, file.name);
    const relative = path.slice(directory.length + 1);
    output.push({ file: relative, sha256: await digest(path) });
  }
  return output.sort((a, b) => a.file.localeCompare(b.file));
}

export async function checkCandidate(directory, { publish = false } = {}) {
  const manifest = await readJson(resolve(directory, "candidate.json"));
  assert.equal(manifest.format, 1);
  assert.deepEqual(manifest.archives.map((item) => item.name).sort(), ["@kestreljs/create-kestrel", "@kestreljs/framework"]);
  await verifyHashes(directory, manifest.archives);
  if (publish) {
    assert.equal(manifest.status, "validated", "The candidate has not passed validation");
    assert(!manifest.source.dirty, "Publishing requires a candidate built from a clean commit");
    assert(manifest.verifications.some((entry) => entry.node === "v24.11.0"), "Minimum Node 24.11 verification is missing");
    const runtime = await checkEvidence(directory, manifest);
    assert.equal(runtime.node, validationNode, "Publication requires consumer evidence on Node 24.11.0");
    await verifyHashes(directory, manifest.reports);
    assert.deepEqual(await reportInventory(directory), manifest.reports, "Candidate report inventory changed");
    // The candidate is intentionally independent of the current checkout when publishing.
    const policy = await readJson(resolve(directory, "reports/security-policy.json"));
    for (const entry of policy.exceptions) assert(new Date(`${entry.expires}T00:00:00Z`) > new Date(), `Expired exception: ${entry.advisory}`);
    assert(Date.now() - Date.parse(manifest.validatedAt) < 7 * 86400000, "Candidate validation is older than seven days; validate again");
  }
  return manifest;
}
