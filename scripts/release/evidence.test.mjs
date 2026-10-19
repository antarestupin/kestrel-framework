import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJson } from "./common.mjs";
import { assertSupportedNode, checkEvidence, validationNode, validationNpm, verificationSelections } from "./evidence.mjs";

/** Keep fixtures independent from command execution; no consumer installations are needed. */
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-worker-evidence-"));
  const manifest = { source: { commit: "commit", dirty: false, sha256: "source" }, archives: [{ file: "framework.tgz", sha256: "archive" }] };
  const receipt = { source: manifest.source, status: "passed", node: validationNode, npm: validationNpm };
  const documentation = join(directory, "reports/docs/result.json");
  const worker = (selection) => join(directory, "reports/consumers", selection, "result.json");
  try {
    await writeJson(documentation, receipt);
    for (const selection of verificationSelections) {
      await writeJson(worker(selection), { ...receipt, selection, archives: manifest.archives });
    }
    await run({ directory, manifest, receipt, documentation, worker });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("requires all consumer selections and the documentation build before finalization", async () => {
  await fixture(async ({ directory, manifest, documentation, worker, receipt }) => {
    await checkEvidence(directory, manifest);
    await rm(documentation);
    await assert.rejects(checkEvidence(directory, manifest), /ENOENT/);
    await writeJson(documentation, receipt);
    await rm(worker("redis-atlas-app"));
    await assert.rejects(checkEvidence(directory, manifest), /ENOENT/);
  });
});

test("rejects stale, failed, mismatched-runtime, and mixed-archive consumer evidence", async () => {
  await fixture(async ({ directory, manifest, worker, receipt }) => {
    const selection = "postgres-app";
    const success = { ...receipt, selection, archives: manifest.archives };
    for (const [change, message] of [
      [{ source: { ...manifest.source, sha256: "other source" } }, /source inputs/],
      [{ node: "v24.14.0" }, /same Node runtime/],
      [{ npm: "11.10.0" }, /npm 11.9.0/],
      [{ status: "failed" }, /has not passed/],
      [{ selection: "redis-app" }, /selection mismatch/],
      [{ archives: [{ ...manifest.archives[0], sha256: "other archive" }] }, /same candidate archives/],
    ]) {
      await writeJson(worker(selection), { ...success, ...change });
      await assert.rejects(checkEvidence(directory, manifest), message);
    }
  });
});

test("documentation evidence requires matching sources and a supported runtime", async () => {
  await fixture(async ({ directory, manifest, documentation, receipt }) => {
    for (const change of [{ source: { ...manifest.source, dirty: true } }, { node: "v24.10.0" }, { status: "failed" }]) {
      await writeJson(documentation, { ...receipt, ...change });
      await assert.rejects(checkEvidence(directory, manifest));
    }
  });
});


test("accepts supported Node 24 releases and rejects unsupported or prerelease runtimes", () => {
  for (const version of ["v24.11.0", "v24.11.9", "v24.14.0"]) assertSupportedNode(version);
  for (const version of ["v24.10.9", "v23.11.0", "v25.0.0", "v24.14.0-rc.1", "invalid"]) {
    assert.throws(() => assertSupportedNode(version), /Node >=24.11.0 <25/);
  }
});

test("returns the actual worker runtime without inventing minimum-runtime verification", async () => {
  await fixture(async ({ directory, manifest, documentation, worker, receipt }) => {
    const current = { ...receipt, node: "v24.14.0" };
    await writeJson(documentation, current);
    for (const selection of verificationSelections) {
      await writeJson(worker(selection), { ...current, selection, archives: manifest.archives });
    }
    assert.deepEqual(await checkEvidence(directory, manifest), { node: "v24.14.0", npm: validationNpm });
    // The existing archives and documentation can then be checked on the CI minimum.
    for (const selection of verificationSelections) {
      await writeJson(worker(selection), { ...receipt, selection, archives: manifest.archives });
    }
    assert.deepEqual(await checkEvidence(directory, manifest), { node: validationNode, npm: validationNpm });
  });
});
