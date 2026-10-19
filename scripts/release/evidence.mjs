import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readJson } from "./common.mjs";

// CI workers use the same public selection list as local archive verification.
export const consumerVariants = [
  ["postgres-app", "postgres", false],
  ["redis-app", "redis", false],
  ["postgres-atlas-app", "postgres", true],
  ["redis-atlas-app", "redis", true],
];
export const verificationSelections = ["package", ...consumerVariants.map(([name]) => name)];
export const validationNode = "v24.11.0";
export const validationNpm = "11.9.0";

/** Local validation accepts the package engine range; CI pins the minimum separately. */
export function assertSupportedNode(version) {
  assert.match(version, /^v24\.(\d+)\.(\d+)$/u, "Release validation requires Node >=24.11.0 <25");
  assert(Number(version.split(".")[1]) >= 11, "Release validation requires Node >=24.11.0 <25");
}

/** Reject incomplete or mixed evidence before sealing a candidate or publishing it. */
export async function checkEvidence(directory, manifest) {
  const documentation = await readJson(resolve(directory, "reports/docs/result.json"));
  const check = (receipt) => {
    assert.deepEqual(receipt.source, manifest.source, "Evidence requires the candidate source inputs");
    assertSupportedNode(receipt.node);
    assert.equal(receipt.npm, validationNpm, "Evidence requires npm 11.9.0");
    assert.equal(receipt.status, "passed", "Evidence has not passed validation");
  };
  check(documentation);
  let runtime;
  for (const selection of verificationSelections) {
    const receipt = await readJson(resolve(directory, "reports/consumers", selection, "result.json"));
    check(receipt);
    // Re-verification may use a different runtime than the build, but workers must agree.
    runtime ??= { node: receipt.node, npm: receipt.npm };
    assert.equal(receipt.node, runtime.node, "Consumer evidence requires the same Node runtime");
    assert.equal(receipt.selection, selection, "Consumer evidence selection mismatch");
    assert.deepEqual(receipt.archives, manifest.archives, "Consumer evidence requires the same candidate archives");
  }
  return runtime;
}
