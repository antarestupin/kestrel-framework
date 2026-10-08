import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAudit } from "./security.mjs";

const advisory = { url: "https://github.com/advisories/GHSA-test", severity: "high" };
const report = { auditReportVersion: 2, metadata: { vulnerabilities: { high: 2 } }, vulnerabilities: {
  parent: { via: ["leaf"], nodes: ["node_modules/parent"] },
  leaf: { via: [advisory], nodes: ["node_modules/leaf"] },
} };
const lock = { packages: { "node_modules/leaf": { version: "1.0.0" } } };
const now = new Date("2026-10-08T00:00:00Z");
const exception = { package: "leaf", advisory: advisory.url, severity: "high", versions: ["1.0.0"], scopes: ["framework"], owner: "maintainer", reason: "Fixture mitigation", expires: "2026-11-08" };

test("blocks advisory causes once instead of counting their parents again", () => {
  const result = evaluateAudit(report, lock, { exceptions: [] }, "framework", now);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.passed, false);
});
test("exceptions match the advisory, version, scope, and severity exactly", () => {
  assert(evaluateAudit(report, lock, { exceptions: [exception] }, "framework", now).passed);
  for (const replacement of [{ advisory: "another" }, { versions: ["2.0.0"] }, { scopes: ["workspace"] }, { severity: "moderate" }]) {
    assert(!evaluateAudit(report, lock, { exceptions: [{ ...exception, ...replacement }] }, "framework", now).passed);
  }
});
test("expiry and incomplete registry reports fail closed", () => {
  assert.throws(() => evaluateAudit(report, lock, { exceptions: [{ ...exception, expires: "2026-10-08" }] }, "framework", now), /Expired/);
  for (const invalid of [{}, { error: "offline" }, { ...report, vulnerabilities: { parent: { via: ["missing"] } } }]) {
    assert.throws(() => evaluateAudit(invalid, lock, { exceptions: [] }, "framework", now));
  }
});
test("moderate findings remain visible without blocking", () => {
  const moderate = structuredClone(report);
  moderate.vulnerabilities.leaf.via[0].severity = "moderate";
  const result = evaluateAudit(moderate, lock, { exceptions: [] }, "framework", now);
  assert(result.passed);
  assert.equal(result.findings.length, 1);
});

test("parent-only cycles cannot turn an incomplete audit into a pass", () => {
  const cyclic = { ...report, vulnerabilities: { a: { via: ["b"] }, b: { via: ["a"] } } };
  assert.throws(() => evaluateAudit(cyclic, lock, { exceptions: [] }, "framework", now), /Missing advisory causes/);
});
