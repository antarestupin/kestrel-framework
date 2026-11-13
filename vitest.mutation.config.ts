import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const frameworkSource = "src/packages/kestrel/src";
const historyTests = [
  "db/history/*.test.ts",
  "db/schema_contributions/migration_generator.test.ts",
];
const schemaTests = [
  "db/schema_contributions/*.test.ts",
  "db/framework_table.test.ts",
  "db/history/definition.test.ts",
  "db/reference_counter/definition.test.ts",
  "database/seeder/*.test.ts",
  "observability/db/*.test.ts",
  "log/db/*.test.ts",
  "email/adapters/postgres/schema.test.ts",
  "studio/extensions/database/schema_source*.test.ts",
];

// Limit costly profiles at Vitest discovery so Stryker still activates static mutants
// before imports. The explicit Stryker testFiles filter activates them after collection.
const focusedIncludes = new Map<string, string[]>([
  ["password-verification", ["authentication/mechanisms/password/hashers/argon2id/*.test.ts"]],
  // Load declarations inside test bodies to attribute invalid static mutants to assertions.
  ["authentication-adapters-postgres-schema", ["authentication/adapters/postgres/schema.test.ts"]],
  ["tokens-adapters-schema", ["tokens/adapters/postgres/schema.test.ts"]],
  ["authorization-postgres-schema", ["authorization/adapters/postgres/schema.test.ts"]],
  ["http-access-policy", ["http/access_policy.test.ts"]],
  ["http-hardening-configuration", ["http/hardening/configuration.test.ts"]],
  ["workflow-adapter-contracts", [
    "workflows/adapters/definition.test.ts",
    "workflows/adapters/postgres/polling_error.test.ts",
    "workflows/adapters/postgres/schema.test.ts",
  ]],
  ["db-history-declarations", historyTests],
  ["db-history-column-types", historyTests],
  ["db-history-identities", historyTests],
  ["db-history-events", historyTests],
  ["db-reference-counter-declarations", [
    "db/reference_counter/*.test.ts",
    "db/provider.test.ts",
    "db/schema_contributions/migration_generator.test.ts",
  ]],
  ["db-schema-table-metadata", schemaTests],
  ["db-schema-descriptions", schemaTests],
]);
const includes = focusedIncludes.get(process.env.KESTREL_MUTATION_MODE ?? "") ?? ["**/*.test.{ts,tsx}"];

export default defineConfig({
  test: {
    include: includes.map((pattern) => `${frameworkSource}/${pattern}`),
    // Snapshot coverage after each file instead of accumulating it in every file's metadata.
    runner: fileURLToPath(new URL("./scripts/testing/coverage-runner.mjs", import.meta.url)),
    isolate: false,
    // Guard effective driver routing before mutations can discard connection settings.
    setupFiles: [fileURLToPath(new URL("./scripts/testing/setup.mjs", import.meta.url))],
    // Provision a database once per Stryker worker before any Vitest fork starts.
    globalSetup: [fileURLToPath(new URL("./scripts/testing/mutation-global-setup.mjs", import.meta.url))],
    // CLI subprocess dependencies are opaque to the import graph. Including its entrypoint
    // in a full assessment must still run every baseline suite, including the CLI checks.
    // An absolute path also matches inside the hidden .stryker-tmp sandbox.
    forceRerunTriggers: [...configDefaults.forceRerunTriggers, fileURLToPath(new URL("./src/packages/kestrel/src/cli/main.ts", import.meta.url))],
  },
});
