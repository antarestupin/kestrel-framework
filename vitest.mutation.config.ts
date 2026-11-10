import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Include every framework unit and integration suite, without application or generator tests.
export default defineConfig({
  test: {
    include: ["src/packages/kestrel/src/**/*.test.{ts,tsx}"],
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
