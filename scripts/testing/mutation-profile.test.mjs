import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import test from "node:test";

import { mutationArguments, staticSamplePatterns } from "./mutation-profile.mjs";
import { runMutation } from "./mutation.mjs";

test("profiles preserve Stryker flags and require a bounded existing component", () => {
  assert.deepEqual(mutationArguments(["--mode", "fast", "--incremental"]), {
    mode: "fast", component: undefined, args: ["--incremental"], budgetMs: undefined,
  });
  assert.equal(mutationArguments(["--mode", "component", "di"]).component, "di");
  for (const component of [undefined, "../app", "*", "unknown_component"]) {
    assert.throws(() => mutationArguments(["--mode", "component", ...component ? [component] : []]));
  }
  assert.throws(() => mutationArguments(["--mode", "fast", "--ignoreStatic=false"]));
  assert.throws(() => mutationArguments(["--mode", "component", "di", "--mutate=src/**"]));
  assert.equal(mutationArguments(["--mode", "static-sample"]).budgetMs, 600_000);
  assert.equal(staticSamplePatterns().length, 9);
});

test("the sample deadline checkpoints Stryker and still cleans owned resources", async () => {
  let interrupted = false;
  let cleaned = false;
  const code = await runMutation(["--mode", "static-sample"], {
    environment: {}, signals: new EventEmitter(), budgetMs: 10,
    spawnChild(_executable, args, options) {
      assert.deepEqual(args.slice(1), ["run"]);
      assert.equal(options.env.KESTREL_MUTATION_MODE, "static-sample");
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

test("profiles isolate reports and caches and only fast mode suppresses static activation", async () => {
  const previousMode = process.env.KESTREL_MUTATION_MODE;
  const previousComponent = process.env.KESTREL_MUTATION_COMPONENT;
  try {
    for (const mode of ["fast", "component", "static-sample"]) {
      process.env.KESTREL_MUTATION_MODE = mode;
      process.env.KESTREL_MUTATION_COMPONENT = mode === "component" ? "di" : "";
      const { default: config } = await import(`../../stryker.config.mjs?profile-test=${mode}`);
      assert.equal(config.ignoreStatic, mode === "fast");
      const directory = `artifacts/mutation/${mode}${mode === "component" ? "-di" : ""}`;
      assert.equal(config.incrementalFile, `${directory}/incremental.json`);
      assert.equal(config.jsonReporter.fileName, `${directory}/mutation.json`);
      assert.equal(config.thresholds.break, null);
      if (mode === "component") assert.equal(config.mutate[0], "src/packages/kestrel/src/di/**/*.{ts,tsx}");
      if (mode === "static-sample") assert.equal(config.mutate.filter((pattern) => !pattern.startsWith("!")).length, 9);
    }
  } finally {
    if (previousMode === undefined) delete process.env.KESTREL_MUTATION_MODE;
    else process.env.KESTREL_MUTATION_MODE = previousMode;
    if (previousComponent === undefined) delete process.env.KESTREL_MUTATION_COMPONENT;
    else process.env.KESTREL_MUTATION_COMPONENT = previousComponent;
  }
});
