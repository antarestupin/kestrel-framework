import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npm, readJson, writeJson, root } from "./common.mjs";

/** Evaluate advisory leaves, not duplicated npm parent/metavulnerability counts. */
export function evaluateAudit(report, lock, policy, scope, now = new Date()) {
  if (report.auditReportVersion !== 2 || report.error || !report.vulnerabilities || !report.metadata?.vulnerabilities) {
    throw new Error("Missing or unsupported npm audit report; security validation cannot pass.");
  }
  for (const entry of policy.exceptions) {
    if (!entry.package || !entry.advisory || !entry.owner || !entry.reason || !entry.versions?.length || !entry.scopes?.length || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) throw new Error("Incomplete security exception.");
    if (!Number.isFinite(Date.parse(`${entry.expires}T00:00:00Z`)) || new Date(`${entry.expires}T00:00:00Z`) <= now) throw new Error(`Expired security exception: ${entry.advisory}`);
  }
  // Every parent chain must reach an advisory, including graphs containing cycles.
  const causes = (name, seen = new Set()) => {
    if (seen.has(name)) return [];
    const entry = report.vulnerabilities[name];
    if (!entry || !Array.isArray(entry.via)) throw new Error(`Unresolved advisory parent: ${name}`);
    const next = new Set([...seen, name]);
    return entry.via.flatMap((item) => typeof item === "string" ? causes(item, next) : [item]);
  };
  for (const name of Object.keys(report.vulnerabilities)) {
    if (!causes(name).length) throw new Error(`Missing advisory causes for ${name}`);
  }
  if (!Object.keys(report.vulnerabilities).length && report.metadata.vulnerabilities.total > 0) throw new Error("Incomplete audit vulnerability inventory");
  const findings = [];
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    if (!Array.isArray(vulnerability.via) || !vulnerability.via.length) throw new Error(`Missing advisory evidence for ${name}`);
    for (const advisory of vulnerability.via) {
      if (typeof advisory === "string") {
        if (!report.vulnerabilities[advisory]) throw new Error(`Unresolved advisory parent: ${advisory}`);
        continue;
      }
      if (!advisory.url || !["info", "low", "moderate", "high", "critical"].includes(advisory.severity)) throw new Error(`Invalid advisory for ${name}`);
      const versions = [...new Set(vulnerability.nodes.map((path) => lock.packages[path]?.version))];
      if (!versions.length || versions.includes(undefined)) throw new Error(`Missing locked versions for ${name}`);
      const exception = policy.exceptions.find((entry) => entry.package === name && entry.advisory === advisory.url && entry.scopes.includes(scope) && versions.every((version) => entry.versions.includes(version)) && entry.severity === advisory.severity);
      findings.push({ package: name, advisory: advisory.url, severity: advisory.severity, versions, exception: exception ?? null });
    }
  }
  const blocked = findings.filter((finding) => ["high", "critical"].includes(finding.severity) && !finding.exception);
  // Cyclic npm parent edges are allowed, but high severities must have a real advisory cause.
  if (!findings.length && Object.keys(report.vulnerabilities).length) throw new Error("Audit contains no advisory causes.");
  return { scope, checkedAt: now.toISOString(), findings, blocked, passed: blocked.length === 0 };
}

/** Retain raw reports and resolved locks, including when the registry or policy rejects them. */
export async function audit(directory, scope, reportDirectory, { production = false } = {}) {
  const result = await npm(["audit", "--json", "--ignore-scripts", ...(production ? ["--omit=dev"] : [])], { cwd: directory, capture: true, allowed: [0, 1], log: resolve(reportDirectory, `${scope}-audit.log`) });
  const report = JSON.parse(result.stdout);
  await writeJson(resolve(reportDirectory, `${scope}-audit.json`), report);
  const lock = await readJson(resolve(directory, "package-lock.json"));
  await writeJson(resolve(reportDirectory, `${scope}-lock.json`), lock);
  const evaluation = evaluateAudit(report, lock, await readJson(resolve(root, "scripts/release/security-policy.json")), scope);
  await writeJson(resolve(reportDirectory, `${scope}-security.json`), evaluation);
  console.info(`${scope}: ${evaluation.findings.length} advisories, ${evaluation.blocked.length} blocking.`);
  if (!evaluation.passed) throw new Error(`${scope}: blocking security advisories. See ${reportDirectory}.`);
  return evaluation;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await audit(resolve(process.argv[2] ?? root), process.argv[3] ?? "workspace", resolve(process.argv[4] ?? "artifacts/security"));
}
