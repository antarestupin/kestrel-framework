import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("@stryker-mutator/core/package.json")), "bin/stryker.js");

/** Compare semantic test identities: numeric report IDs can differ with collection order. */
function outcomes(report) {
  const tests = new Map(Object.entries(report.testFiles).flatMap(([file, suite]) =>
    suite.tests.map((entry) => [entry.id, `${file}#${entry.name}`])));
  return Object.entries(report.files).flatMap(([file, source]) => source.mutants.map((mutant) => ({
    file, location: mutant.location, replacement: mutant.replacement,
    status: mutant.status, static: mutant.static,
    coveredBy: (mutant.coveredBy ?? []).map((id) => tests.get(id)).sort(),
  })));
}

test("preserves cached-module coverage, static activation and recovery after import errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-mutation-coverage-"));
  try {
    await mkdir(join(directory, "src"));
    await mkdir(join(directory, "tests"));
    await symlink(join(root, "node_modules"), join(directory, "node_modules"));
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    // Mutating startup validation produces import errors; later mutations must still run.
    await writeFile(join(directory, "src/contract.ts"), `
export const settings = { enabled: true, label: "ready", offset: 2 };
if (settings.enabled !== true) throw new Error("Invalid startup settings");
export const banner = settings.label.toUpperCase();
export function evaluate(value: number): number {
  if (value > 0) return value + settings.offset;
  return -value + 10;
}
`);
    for (const name of ["a", "b", "c"]) {
      // Only the final file checks static values and the positive runtime branch.
      await writeFile(join(directory, `tests/${name}.test.ts`), `
import { expect, it } from "vitest";
import { settings, banner, evaluate } from "../src/contract.js";
it("checks ${name}", () => {
  expect(evaluate(0)).toBe(10);
  ${name === "c" ? 'expect(settings).toEqual({ enabled: true, label: "ready", offset: 2 }); expect(banner).toBe("READY"); expect(evaluate(1)).toBe(3); expect(evaluate(-1)).toBe(11);' : ""}
});
`);
    }
    await writeFile(join(directory, "sequencer.mjs"), `
import { BaseSequencer } from "vitest/node";
export default class extends BaseSequencer {
  async sort(specs) { return [...specs].sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
}
`);
    await writeFile(join(directory, "runner.mjs"), await readFile(new URL("./coverage-runner.mjs", import.meta.url)));
    const reports = [];
    for (const isolated of [true, false]) {
      const mode = isolated ? "isolated" : "cached";
      await writeFile(join(directory, `vitest.${mode}.config.mjs`), `
import { defineConfig } from "vitest/config";
import Sequencer from "./sequencer.mjs";
export default defineConfig({ cacheDir: "./.vite-${mode}", test: {
  include: ["tests/*.test.ts"], isolate: ${isolated}, sequence: { sequencer: Sequencer },
  ${isolated ? "" : 'runner: "./runner.mjs",'}
} });
`);
      await writeFile(join(directory, `stryker.${mode}.config.mjs`), `export default ${JSON.stringify({
        testRunner: "vitest", plugins: ["@stryker-mutator/vitest-runner"],
        vitest: { configFile: `vitest.${mode}.config.mjs`, related: true, pool: "forks" },
        mutate: ["src/**/*.ts"], concurrency: 1,
        ignorePatterns: ["artifacts/**", ".vite-*/**"],
        reporters: ["json"], jsonReporter: { fileName: `artifacts/${mode}.json` },
        thresholds: { break: null },
      })};`);
      execFileSync(process.execPath, [cli, "run", `stryker.${mode}.config.mjs`], {
        cwd: directory, timeout: 60_000, stdio: "pipe",
      });
      reports.push(JSON.parse(await readFile(join(directory, `artifacts/${mode}.json`), "utf8")));
    }
    const reference = outcomes(reports[0]);
    assert.ok(reference.some((entry) => entry.status === "RuntimeError"));
    assert.ok(reference.some((entry) => entry.static && entry.status === "Killed"));
    assert.ok(reference.some((entry) => entry.coveredBy.some((id) => id.endsWith("#checks c"))));
    assert.deepEqual(outcomes(reports[1]), reference);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
