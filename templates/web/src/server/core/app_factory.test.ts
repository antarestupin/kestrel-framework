import { expect, it, vi } from "vitest";
import { runCli } from "@kestrel/framework/cli";
import { createApp } from "./app_factory.js";

it("lists application commands without initializing database or HTTP services", async () => {
  const app = createApp();
  const output: string[] = [];
  // Fail immediately if a help invocation resolves infrastructure accidentally.
  const forbidden = () => { throw new Error("Infrastructure must remain lazy."); };
  app.container.registerFactory("databaseClient", forbidden);
  app.container.registerFactory("httpRuntime", forbidden);
  try {
    expect(await runCli(app, ["--help"], { writeOutput: (text) => output.push(text) })).toBe(0);
    expect(output.join("")).toContain("generate");
    expect(output.join("")).toContain("database");
    expect(output.join("")).toContain("run");
  } finally {
    await app.dispose();
  }
});

it("dispatches database migrations through the application CLI provider", async () => {
  const app = createApp({ web: false });
  const migrate = vi.fn(async () => {});
  // Replace the application-owned maintenance service, not framework modules or globals.
  app.container.registerValue("databaseMaintenance", { migrate });
  const output: string[] = [];
  try {
    expect(await runCli(app, ["database", "migrate"], { writeOutput: (text) => output.push(text) })).toBe(0);
    expect(migrate).toHaveBeenCalledOnce();
    expect(output.join("")).toContain("Database migrated.");
  } finally {
    await app.dispose();
  }
});
