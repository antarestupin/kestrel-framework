import { readFileSync, readdirSync } from "node:fs";
import { matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import config from "../../stryker.config.mjs";

// Audit against Stryker's actual full-scope selection so newly added code cannot
// silently fall outside the progress inventory. This never starts a mutation run.
const root = fileURLToPath(new URL("../../", import.meta.url));
const inventory = JSON.parse(readFileSync(new URL("../../docs/implementation/mutation_testing_inventory.json", import.meta.url), "utf8"));
const sourceRoot = resolve(root, inventory.sourceRoot);
const problems = [];
const ids = new Set();
const counts = new Map();
if (process.env.KESTREL_MUTATION_MODE && process.env.KESTREL_MUTATION_MODE !== "full") {
  throw new Error("Run the inventory check outside a mutation profile.");
}
for (const entry of readdirSync(sourceRoot, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = relative(root, resolve(entry.parentPath, entry.name)).replaceAll("\\", "/");
  if (config.ignorePatterns.some((pattern) => matchesGlob(path, pattern))) continue;
  let selected = false;
  for (const pattern of config.mutate) {
    if (matchesGlob(path, pattern.replace(/^!/u, ""))) selected = !pattern.startsWith("!");
  }
  if (!selected) continue;
  const component = relative(sourceRoot, resolve(root, path)).split(/[\\/]/u)[0];
  counts.set(component, (counts.get(component) ?? 0) + 1);
}
const states = new Set(["not-assessed", "partial", "assessment-complete-review-pending", "reviewed", "no-runtime-sources"]);
const evidenceIds = new Set(inventory.evidence.map((entry) => entry.id));
for (const lot of inventory.lots) {
  if (ids.has(lot.id)) problems.push(`Duplicate component lot: ${lot.id}`);
  ids.add(lot.id);
  if (lot.scope !== `${lot.id}/**/*`) problems.push(`Unexpected component partition: ${lot.id}`);
  if (!states.has(lot.state)) problems.push(`Unknown assessment state: ${lot.id}`);
  if (lot.sourceFiles !== (counts.get(lot.id) ?? 0)) problems.push(`Source inventory changed: ${lot.id} (${lot.sourceFiles} recorded, ${counts.get(lot.id) ?? 0} selected)`);
  for (const reference of lot.evidence) if (!evidenceIds.has(reference)) problems.push(`Missing evidence: ${reference}`);
}
for (const component of counts.keys()) if (!ids.has(component)) problems.push(`Missing component lot: ${component}`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else {
  console.info(`Mutation inventory aligned: ${ids.size} lots, ${[...counts.values()].reduce((sum, count) => sum + count, 0)} candidate source files. Assessment states are manually reviewed, not inferred from source counts.`);
}
