import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("the executable prints leaf errors nested beneath shutdown aggregates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-diagnostics-"));
  try {
    const fixture = join(directory, "app.mjs");
    await writeFile(fixture, `
      import { App } from ${JSON.stringify(new URL("../app/index.ts", import.meta.url).href)};
      const app = new App({});
      // Disposal adds another aggregate around this nested polling failure.
      app.shutdown.registerDrain(async () => {
        throw new AggregateError([
          new AggregateError([new Error("Missing workflow task relation")], "Polling failed"),
        ], "Workflow drain failed");
      });
      export default app;
    `);
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
      fileURLToPath(new URL("./main.ts", import.meta.url)), fixture, "--help"], { encoding: "utf8", timeout: 5_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Missing workflow task relation");
    expect(result.stderr).not.toContain("[Array]");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("the executable exits at its deadline even when a command and diagnostic sink never finish", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-shutdown-"));
  try {
    const fixture = join(directory, "app.mjs");
    await writeFile(fixture, `
      import { App } from ${JSON.stringify(new URL("../app/index.ts", import.meta.url).href)};
      import { defineCliController } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
      const app = new App({}, { shutdown: { timeoutMs: 40, drainMs: 10 } });
      app.container.registerValue("observationRecorder", { flush: () => new Promise(() => {}) });
      app.catalog.contribute({ fixture: { controllers: { cli: {
        hang: defineCliController({ command: "hang", description: "Exercise bounded shutdown", observe: false,
          handler: async () => {
            // This live resource makes setting exitCode alone insufficient.
            setInterval(() => {}, 1000);
            setTimeout(() => process.kill(process.pid, "SIGTERM"), 10);
            await new Promise(() => {});
          },
        }),
      } } } });
      export default app;
    `);
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
      fileURLToPath(new URL("./main.ts", import.meta.url)), fixture, "hang"], { encoding: "utf8", timeout: 5_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Forced process termination.");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
