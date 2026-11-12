import { expect, it, vi } from "vitest";

import { App } from "../../app/index.js";
import { CliCommandManager } from "../../cli/index.js";
import { databaseCliControllers } from "./database_cli_controllers.js";

it.each([
  { command: "migrate", method: "migrate", message: "Database migrated.", mode: "minimal" },
  { command: "reset", method: "reset", message: "Database reset.", mode: "minimal" },
  { command: "reset-seed", method: "resetAndSeed", message: "Database reset and seeded.", mode: "minimal" },
  { command: "seed", method: "seed", message: "Database seeded.", mode: "standard" },
] as const)("runs the $command maintenance command through its registered dependency", async ({
  command, method, message, mode,
}) => {
  const app = new App({});
  const maintenance = { migrate: vi.fn(), reset: vi.fn(), resetAndSeed: vi.fn(), seed: vi.fn() };
  const output = vi.fn();
  const errors = vi.fn();
  const manager = new CliCommandManager(app, { writeOutput: output, writeError: errors });
  app.container.registerValue("databaseMaintenance", maintenance);
  for (const controller of Object.values(databaseCliControllers)) manager.register(controller);

  try {
    // Exercise the real command, including boot mode, dependency resolution and output validation.
    expect(await manager.run(["database", command, "--_format", "json"])).toBe(0);
    expect(app.bootPlan.runningMode).toBe(mode);
    expect(errors).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify({ message })}\n`);
    for (const [name, operation] of Object.entries(maintenance)) {
      expect(operation).toHaveBeenCalledTimes(Number(name === method));
    }
  } finally {
    await app.dispose();
  }
});
