import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateFile, digest, writeJson } from "./common.mjs";
import { checkCandidate, verifyHashes } from "./candidate.mjs";

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
    const policyHash = await digest(join(directory, "reports/security-policy.json"));
    const manifest = { format: 1, status: "validated", source: { dirty: false }, validatedAt: new Date().toISOString(), archives: [
      { name: "@kestreljs/framework", file: "package.tgz", sha256 },
      { name: "@kestreljs/create-kestrel", file: "package.tgz", sha256 },
    ], verifications: [{ node: "v24.11.0" }, { node: "v24.14.0" }], reports: [{ file: "reports/security-policy.json", sha256: policyHash }] };
    await writeJson(join(directory, "candidate.json"), manifest);
    await checkCandidate(directory, { publish: true });
    await writeJson(join(directory, "reports/security-policy.json"), { exceptions: [{ advisory: "expired", expires: "2000-01-01" }] });
    await assert.rejects(checkCandidate(directory, { publish: true }), /Changed artifact/);
    manifest.reports[0].sha256 = await digest(join(directory, "reports/security-policy.json"));
    await writeJson(join(directory, "candidate.json"), manifest);
    await assert.rejects(checkCandidate(directory, { publish: true }), /Expired exception/);
    await writeJson(join(directory, "reports/security-policy.json"), { exceptions: [] });
    manifest.reports[0].sha256 = policyHash;
    manifest.validatedAt = "2000-01-01T00:00:00Z";
    await writeJson(join(directory, "candidate.json"), manifest);
    await assert.rejects(checkCandidate(directory, { publish: true }), /seven days/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
