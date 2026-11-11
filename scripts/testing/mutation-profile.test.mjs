import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, readdir, rm } from "node:fs/promises";
import { matchesGlob, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import config from "../../stryker.config.mjs";
import { focusedPatterns, focusedProfileNames, mutationArguments, shutdownPatterns, staticSamplePatterns } from "./mutation-profile.mjs";
import { runMutation } from "./mutation.mjs";

test("profiles preserve Stryker flags and require a bounded existing component", () => {
  assert.deepEqual(mutationArguments(["--mode", "fast", "--incremental"]), {
    mode: "fast", component: undefined, args: ["--incremental"], budgetMs: 600_000,
  });
  assert.equal(mutationArguments(["--mode", "component", "di"]).component, "di");
  assert.equal(mutationArguments(["--mode", "component", "di"]).budgetMs, 600_000);
  assert.equal(mutationArguments(["--incremental"]).budgetMs, undefined);
  for (const component of [undefined, "../app", "*", "unknown_component"]) {
    assert.throws(() => mutationArguments(["--mode", "component", ...component ? [component] : []]));
  }
  assert.throws(() => mutationArguments(["--mode", "fast", "--ignoreStatic=false"]));
  assert.throws(() => mutationArguments(["--mode", "component", "di", "--mutate=src/**"]));
  assert.equal(mutationArguments(["--mode", "static-sample"]).budgetMs, 600_000);
  assert.equal(staticSamplePatterns().length, 9);
  assert.equal(mutationArguments(["--mode", "shutdown"]).budgetMs, 600_000);
  assert.equal(mutationArguments(["--mode", "authentication-sessions"]).budgetMs, 600_000);
  assert.match(shutdownPatterns()[0], /^src\/packages\/kestrel\/src\/app\/app\.ts:\d+-\d+$/u);
});

test("worker mutation profiles partition the scheduler without gaps or overlaps", async () => {
  const scheduler = "src/packages/kestrel/src/workers/scheduler.ts";
  const source = await readFile(new URL(`../../${scheduler}`, import.meta.url), "utf8");
  const coverage = Array.from({ length: source.split("\n").length }, () => 0);
  for (const mode of ["workers-delivery", "workers-scheduler"]) {
    for (const pattern of focusedPatterns(mode)) {
      const [file, range] = pattern.split(":");
      assert.equal(file, scheduler);
      const [first, last] = range.split("-").map(Number);
      for (let line = first; line <= last; line += 1) coverage[line - 1] += 1;
    }
  }
  for (const [index, count] of coverage.entries()) {
    assert.equal(count, 1, `Scheduler line ${index + 1} must belong to exactly one profile`);
  }
});

test("bounded workflow profiles partition every selected workflow source line", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const workflowRoot = resolve(root, "src/packages/kestrel/src/workflows");
  // The earlier cross-adapter ownership profile supplies the PostgreSQL retryTask range.
  const modes = [...focusedProfileNames().filter((mode) => mode.startsWith("workflow-")), "postgres-ownership"];
  const selectors = modes.flatMap((mode) => focusedPatterns(mode));
  for (const entry of await readdir(workflowRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = resolve(entry.parentPath, entry.name);
    const path = relative(root, absolute).replaceAll("\\", "/");
    const selected = config.mutate.findLast((pattern) => matchesGlob(path, pattern.replace(/^!/u, "")));
    if (!selected || selected.startsWith("!")) continue;
    const lines = (await readFile(absolute, "utf8")).split("\n");
    const coverage = lines.map(() => 0);
    for (const selector of selectors) {
      const [file, range] = selector.split(":");
      if (!matchesGlob(path, file)) continue;
      const [first, last] = range ? range.split("-").map(Number) : [1, lines.length];
      for (let line = first; line <= last; line += 1) coverage[line - 1] += 1;
    }
    for (const [index, count] of coverage.entries()) {
      assert.equal(count, 1, `${path}:${index + 1} must belong to exactly one profile`);
    }
  }
});

for (const [mode, scope] of [...focusedProfileNames().map((mode) => [mode, []]), ["static-sample", []], ["shutdown", []], ["authentication-sessions", []], ["fast", []], ["component", ["di"]]]) {
test(`the ${mode} deadline checkpoints Stryker and still cleans owned resources`, async () => {
  let interrupted = false;
  let cleaned = false;
  const code = await runMutation(["--mode", mode, ...scope], {
    environment: {}, signals: new EventEmitter(), budgetMs: 10,
    spawnChild(_executable, args, options) {
      assert.deepEqual(args.slice(1), ["run"]);
      assert.equal(options.env.KESTREL_MUTATION_MODE, mode);
      const child = new EventEmitter();
      child.kill = (signal) => {
        assert.equal(signal, "SIGINT");
        interrupted = true;
        queueMicrotask(() => child.emit("close", 130, null));
      };
      return child;
    },
    async cleanup(environment) {
      assert.equal(interrupted, true);
      cleaned = true;
      await rm(environment.KESTREL_MUTATION_DATABASE_MANIFEST, { recursive: true });
    },
  });
  assert.equal(code, 130);
  assert.equal(cleaned, true);
});
}

test("profiles isolate reports and caches and only fast mode suppresses static activation", async () => {
  const previousMode = process.env.KESTREL_MUTATION_MODE;
  const previousComponent = process.env.KESTREL_MUTATION_COMPONENT;
  try {
    for (const mode of ["fast", "component", "static-sample", "shutdown", "authentication-sessions", ...focusedProfileNames()]) {
      process.env.KESTREL_MUTATION_MODE = mode;
      process.env.KESTREL_MUTATION_COMPONENT = mode === "component" ? "di" : "";
      const { default: config } = await import(`../../stryker.config.mjs?profile-test=${mode}`);
      assert.equal(config.ignoreStatic, mode === "fast");
      const directory = `artifacts/mutation/${mode}${mode === "component" ? "-di" : ""}`;
      assert.equal(config.incrementalFile, `${directory}/incremental.json`);
      assert.equal(config.jsonReporter.fileName, `${directory}/mutation.json`);
      assert.equal(config.thresholds.break, null);
      if (focusedPatterns(mode)) {
        assert.deepEqual(config.mutate.filter((pattern) => !pattern.startsWith("!")), focusedPatterns(mode));
        assert.equal(mutationArguments(["--mode", mode]).budgetMs, 600_000);
      }
      if (mode === "component") assert.equal(config.mutate[0], "src/packages/kestrel/src/di/**/*.{ts,tsx}");
      if (mode === "static-sample") assert.equal(config.mutate.filter((pattern) => !pattern.startsWith("!")).length, 9);
      if (mode === "shutdown") assert.deepEqual(config.mutate.filter((pattern) => !pattern.startsWith("!")), shutdownPatterns());
      if (mode === "authentication-sessions") assert.equal(config.mutate[0], "src/packages/kestrel/src/authentication/manager.ts");
    }
  } finally {
    if (previousMode === undefined) delete process.env.KESTREL_MUTATION_MODE;
    else process.env.KESTREL_MUTATION_MODE = previousMode;
    if (previousComponent === undefined) delete process.env.KESTREL_MUTATION_COMPONENT;
    else process.env.KESTREL_MUTATION_COMPONENT = previousComponent;
  }
});
