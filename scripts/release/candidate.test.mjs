import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateFile, digest, writeJson } from "./common.mjs";
import { verificationSelections } from "./evidence.mjs";
import { checkCandidate, createCandidateDirectory, reportInventory, verifyHashes } from "./candidate.mjs";

test("creates fresh candidates and preserves evidence when a path is reused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-validation-test-"));
  try {
    const candidate = join(directory, "nested", "candidate");
    await createCandidateDirectory(candidate);
    assert((await stat(join(candidate, "reports"))).isDirectory());
    // A failed run must remain available for diagnosis after a retry.
    const evidence = '{"status":"failed"}\n';
    await writeFile(join(candidate, "candidate.json"), evidence);
    await assert.rejects(createCandidateDirectory(candidate), /already exists: .*Run npm run release:validate without a path/);
    assert.equal(await readFile(join(candidate, "candidate.json"), "utf8"), evidence);

    const occupied = join(directory, "occupied");
    await writeFile(occupied, "existing file");
    await assert.rejects(createCandidateDirectory(occupied), /already exists/);
    assert.equal(await readFile(occupied, "utf8"), "existing file");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("automatic selection skips occupied paths and claims distinct directories concurrently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-automatic-candidate-test-"));
  try {
    const candidate = join(directory, "candidate");
    assert.equal(await createCandidateDirectory(candidate, { unique: true }), candidate);
    // Occupied files count as collisions too and must never be overwritten.
    await writeFile(`${candidate}-2`, "retained evidence");
    const selected = await Promise.all([
      createCandidateDirectory(candidate, { unique: true }),
      createCandidateDirectory(candidate, { unique: true }),
    ]);
    assert.deepEqual(selected.sort(), [`${candidate}-3`, `${candidate}-4`]);
    for (const path of selected) assert((await stat(join(path, "reports"))).isDirectory());
    assert.equal(await readFile(`${candidate}-2`, "utf8"), "retained evidence");
    await assert.rejects(createCandidateDirectory(candidate), /already exists/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects replaced and missing archives before publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-candidate-test-"));
  try {
    await writeFile(join(directory, "framework.tgz"), "original archive");
    const entries = [{ file: "framework.tgz", sha256: await digest(join(directory, "framework.tgz")) }];
    await verifyHashes(directory, entries);
    await writeFile(join(directory, "framework.tgz"), "replacement archive");
    await assert.rejects(verifyHashes(directory, entries), /Changed artifact/);
    await assert.rejects(verifyHashes(directory, [{ ...entries[0], file: "missing.tgz" }]));
    assert.throws(() => candidateFile(directory, "../outside.tgz"), /Invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("rejects incomplete validation even when tarball checksums match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-publication-test-"));
  try {
    await writeFile(join(directory, "package.tgz"), "fixture");
    const sha256 = await digest(join(directory, "package.tgz"));
    const manifest = { format: 1, status: "failed", source: { dirty: false }, archives: [
      { name: "@kestreljs/framework", file: "package.tgz", sha256 },
      { name: "@kestreljs/create-kestrel", file: "package.tgz", sha256 },
    ], verifications: [{ node: "v24.14.0" }] };
    await writeJson(join(directory, "candidate.json"), manifest);
    await assert.rejects(checkCandidate(directory, { publish: true }), /has not passed/);
    manifest.status = "validated";
    await writeJson(join(directory, "candidate.json"), manifest);
    await assert.rejects(checkCandidate(directory, { publish: true }), /Minimum Node/);
    manifest.source.dirty = true;
    await writeJson(join(directory, "candidate.json"), manifest);
    await assert.rejects(checkCandidate(directory, { publish: true }), /clean commit/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("publication also checks retained reports, policy expiry, and evidence age", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-evidence-test-"));
  try {
    await writeFile(join(directory, "package.tgz"), "fixture");
    const sha256 = await digest(join(directory, "package.tgz"));
    await writeJson(join(directory, "reports/security-policy.json"), { exceptions: [] });
    const manifest = { format: 1, status: "validated", source: { dirty: false }, validatedAt: new Date().toISOString(), archives: [
      { name: "@kestreljs/framework", file: "package.tgz", sha256 },
      { name: "@kestreljs/create-kestrel", file: "package.tgz", sha256 },
    ], verifications: [{ node: "v24.11.0" }], reports: [] };
    // A single minimum runtime is sufficient, but every independent success is required.
    const receipt = { source: manifest.source, node: "v24.11.0", npm: "11.9.0", status: "passed" };
    await writeJson(join(directory, "reports/docs/result.json"), receipt);
    for (const selection of verificationSelections) {
      await writeJson(join(directory, "reports/consumers", selection, "result.json"), { ...receipt, selection, archives: manifest.archives });
    }
    manifest.reports = await reportInventory(directory);
    await writeJson(join(directory, "candidate.json"), manifest);
    await checkCandidate(directory, { publish: true });
    // A forged minimum-runtime summary cannot authorize receipts from a newer runtime.
    for (const selection of verificationSelections) {
      await writeJson(join(directory, "reports/consumers", selection, "result.json"), { ...receipt, node: "v24.14.0", selection, archives: manifest.archives });
    }
    await assert.rejects(checkCandidate(directory, { publish: true }), /Publication requires consumer evidence/);
    for (const selection of verificationSelections) {
      await writeJson(join(directory, "reports/consumers", selection, "result.json"), { ...receipt, selection, archives: manifest.archives });
    }
    await writeJson(join(directory, "reports/security-policy.json"), { exceptions: [{ advisory: "expired", expires: "2000-01-01" }] });
    await assert.rejects(checkCandidate(directory, { publish: true }), /Changed artifact/);
    manifest.reports = await reportInventory(directory);
    await writeJson(join(directory, "candidate.json"), manifest);
    await assert.rejects(checkCandidate(directory, { publish: true }), /Expired exception/);
    await writeJson(join(directory, "reports/security-policy.json"), { exceptions: [] });
    manifest.reports = await reportInventory(directory);
    manifest.validatedAt = "2000-01-01T00:00:00Z";
    await writeJson(join(directory, "candidate.json"), manifest);
    await assert.rejects(checkCandidate(directory, { publish: true }), /seven days/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
