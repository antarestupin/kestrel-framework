import { TestRunner } from "vitest";

/** Bound Stryker 10 per-test metadata while retaining Vitest's non-isolated module cache. */
export default class MutationCoverageRunner extends TestRunner {
  async onAfterRunSuite(suite) {
    await super.onAfterRunSuite(suite);
    // Only the file suite owns the coverage assigned by Stryker's final afterAll hook.
    if (suite.file !== suite) return;
    const coverage = suite.meta.mutantCoverage;
    if (!coverage) return;

    // Instrumented functions capture this coverage object on first use. Keep its identity:
    // replacing it would silently lose later coverage from cached modules. Detach the
    // completed file's metadata before starting a fresh per-test map for the next file.
    suite.meta.mutantCoverage = {
      static: { ...coverage.static },
      perTest: coverage.perTest,
    };
    coverage.perTest = {};
  }
}
