import { focusedPatterns, shutdownPatterns, staticSamplePatterns } from "./scripts/testing/mutation-profile.mjs";

const mode = process.env.KESTREL_MUTATION_MODE ?? "full";
const component = process.env.KESTREL_MUTATION_COMPONENT;
const reportDirectory = mode === "full" ? "artifacts/mutation"
  : `artifacts/mutation/${mode}${component ? `-${component}` : ""}`;

/** Mutate every framework component, including browser code and storage adapters. */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  // Limit static-mutant reruns to dependent suites instead of repeating the whole framework.
  // Runtime mutants additionally use Stryker's per-test coverage filtering.
  vitest: { configFile: "vitest.mutation.config.ts", related: true, pool: "forks" },
  // Generated output is unnecessary for source-only suites and can change during builds.
  ignorePatterns: ["**/dist/**", "**/assets/**", "artifacts/**", "coverage/**", ".git/**"],
  mutate: [
    // Keep the accounts/session assessment reproducible, including all manager helpers.
    ...(focusedPatterns(mode) ?? (mode === "authentication-sessions" ? ["src/packages/kestrel/src/authentication/manager.ts"]
      : mode === "shutdown" ? shutdownPatterns() : mode === "static-sample" ? staticSamplePatterns()
      : [`src/packages/kestrel/src/${mode === "component" ? `${component}/` : ""}**/*.{ts,tsx}`])),
    "!src/packages/kestrel/src/**/*.test.{ts,tsx}",
    "!src/packages/kestrel/src/**/*.d.ts",
    // These connection fixtures are repository test infrastructure, not framework behavior.
    "!src/packages/kestrel/src/testing/postgres.ts",
    "!src/packages/kestrel/src/testing/redis.ts",
    // Shared conformance suites register assertions and must not mutate their own tests.
    "!src/packages/kestrel/src/workers/testing/**",
  ],
  // Each worker provisions its own ephemeral PostgreSQL database before its tests run.
  concurrency: 2,
  ignoreStatic: mode === "fast",
  reporters: ["clear-text", "progress", "html", "json", ...(mode === "static-sample" ? ["event-recorder"] : [])],
  eventReporter: { baseDir: `${reportDirectory}/events` },
  clearTextReporter: { reportTests: false, reportMutants: false },
  htmlReporter: { fileName: `${reportDirectory}/mutation.html` },
  jsonReporter: { fileName: `${reportDirectory}/mutation.json` },
  // Always produce a fresh report. Opt into caching with --incremental when iterating.
  incremental: false,
  incrementalFile: `${reportDirectory}/incremental.json`,
  // Scores are informational; only setup failures and failing baseline tests block the run.
  thresholds: { high: 90, low: 70, break: null },
};
