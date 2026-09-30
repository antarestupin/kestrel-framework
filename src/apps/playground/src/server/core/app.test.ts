import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/** Give each CLI invocation ownership of its module-level application without resetting module caches. */
function runApplication(source: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--import", "zod/compile", "--input-type=module", "--eval", source], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, ENVIRONMENT: "test", LOG_LEVEL: "silent" },
  });
}

it("lists application commands without initializing database or HTTP services", () => {
  const result = runApplication(`
    import app from "./src/server/core/app.ts";
    import { runCli } from "@kestrel/framework/cli";
    // A help command must never resolve either runtime service.
    const forbidden = () => { throw new Error("Infrastructure must remain lazy."); };
    app.container.registerFactory("databaseClient", forbidden);
    app.container.registerFactory("httpRuntime", forbidden);
    process.exitCode = await runCli(app, ["--help"]);
  `);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("generate");
  expect(result.stdout).toContain("database");
  expect(result.stdout).toContain("run");
});

it("dispatches database migrations through the application CLI provider", () => {
  const result = runApplication(`
    import assert from "node:assert/strict";
    import app from "./src/server/core/app.ts";
    import { runCli } from "@kestrel/framework/cli";
    // Replace the owned maintenance service without opening a database connection.
    let migrations = 0;
    app.container.registerValue("databaseMaintenance", { migrate: async () => { migrations++; } });
    process.exitCode = await runCli(app, ["database", "migrate"]);
    assert.equal(migrations, 1);
  `);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Database migrated.");
});
